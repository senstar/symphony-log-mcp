import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import type { LogEntry } from "../lib/log-parser.js";
import * as path from "path";

/**
 * Build a RegExp from search args, handling plain-text escaping and flags.
 */
function buildRegex(
  pattern: string,
  isRegex?: boolean,
  caseSensitive?: boolean
): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  return isRegex
    ? new RegExp(pattern, flags)
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

export async function toolSearchPattern(
  logDir: string | string[],
  args: {
    files: string[];
    pattern: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    contextLines?: number;
    levelFilter?: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
  }
): Promise<string> {
  const contextLines = args.contextLines ?? 0;
  const limit = args.limit ?? 200;
  const levelFilter = args.levelFilter?.map((l) => l.toLowerCase());

  let regex: RegExp;
  try {
    regex = buildRegex(args.pattern, args.isRegex, args.caseSensitive);
  } catch (e) {
    return `Invalid pattern: ${e}`;
  }

  const results: string[] = [];
  let totalMatches = 0;
  const paths = await resolveFileRefs(args.files, logDir);

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch (e) {
      results.push(`Error reading ${fileRef}: ${e}`);
      continue;
    }

    const fileMatches: Array<{ idx: number; entry: LogEntry }> = [];

    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      if (levelFilter && !levelFilter.includes(e.line.level.toLowerCase())) continue;
      if (!isInTimeWindow(e.line.timestamp, args.startTime, args.endTime)) continue;
      if (regex.test(e.fullText ?? e.line.raw) || regex.test(e.line.message)) {
        fileMatches.push({ idx, entry: e });
      }
      regex.lastIndex = 0;
    }

    if (fileMatches.length === 0) continue;

    totalMatches += fileMatches.length;
    results.push(`\n=== ${fileRef} (${fileMatches.length} match(es)) ===\n`);

    for (const { idx, entry } of fileMatches) {
      if (results.length > limit) break;

      // Context before
      if (contextLines > 0) {
        const start = Math.max(0, idx - contextLines);
        for (let i = start; i < idx; i++) {
          results.push(`  ${entries[i].line.timestamp} ${entries[i].line.raw}`);
        }
      }

      // Match
      const l = entry.line;
      results.push(`> [${l.timestamp}] TID ${l.threadId} <${l.level}> ${l.functionalArea ? l.functionalArea + " | " : ""}${l.source}: ${l.message}`);
      if (entry.continuationLines.length > 0) {
        results.push(...entry.continuationLines.slice(0, 8).map((c) => `  ${c.trim()}`));
      }

      // Context after
      if (contextLines > 0) {
        const end = Math.min(entries.length, idx + 1 + contextLines);
        for (let i = idx + 1; i < end; i++) {
          results.push(`  ${entries[i].line.timestamp} ${entries[i].line.raw}`);
        }
      }

      results.push("");
    }
  }

  if (totalMatches === 0) return `No matches found for: ${args.pattern}`;

  return [`Total matches: ${totalMatches}`, ...results].join("\n");
}

// ── Count mode ──────────────────────────────────────────────────────────────

export async function toolSearchCount(
  logDir: string | string[],
  args: {
    files: string[];
    pattern: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    levelFilter?: string[];
    startTime?: string;
    endTime?: string;
  }
): Promise<string> {
  let regex: RegExp;
  try {
    regex = buildRegex(args.pattern, args.isRegex, args.caseSensitive);
  } catch (e) {
    return `Invalid pattern: ${e}`;
  }

  const levelFilter = args.levelFilter?.map((l) => l.toLowerCase());
  const paths = await resolveFileRefs(args.files, logDir);
  const rows: Array<{ file: string; count: number; lines: number; first: string; last: string }> = [];
  let grandTotal = 0;
  let grandLines = 0;

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch {
      rows.push({ file: fileRef, count: -1, lines: 0, first: "", last: "" });
      continue;
    }

    let count = 0;
    let first = "";
    let last = "";
    let lineCount = 0;

    for (const e of entries) {
      lineCount++;
      if (levelFilter && !levelFilter.includes(e.line.level.toLowerCase())) continue;
      if (!isInTimeWindow(e.line.timestamp, args.startTime, args.endTime)) continue;
      if (regex.test(e.fullText ?? e.line.raw) || regex.test(e.line.message)) {
        count++;
        if (!first) first = e.line.timestamp;
        last = e.line.timestamp;
      }
      regex.lastIndex = 0;
    }

    rows.push({ file: fileRef, count, lines: lineCount, first, last });
    grandTotal += count;
    grandLines += lineCount;
  }

  // Format as table
  const lines: string[] = [
    `Pattern: ${args.pattern}`,
    `Files: ${paths.length}, Total matches: ${grandTotal}, Total entries scanned: ${grandLines}`,
    "",
    "File".padEnd(30) + "Count".padStart(8) + "  First".padEnd(16) + "  Last",
    "-".repeat(70),
  ];

  // Sort by count descending
  rows.sort((a, b) => b.count - a.count);

  for (const r of rows) {
    if (r.count < 0) {
      lines.push(`${r.file.padEnd(30)}   ERROR reading file`);
    } else {
      lines.push(
        `${r.file.padEnd(30)}${String(r.count).padStart(8)}  ${(r.first || "-").padEnd(14)}  ${r.last || "-"}`
      );
    }
  }

  return lines.join("\n");
}

// ── Assert-absent mode ──────────────────────────────────────────────────────

export async function toolSearchAssertAbsent(
  logDir: string | string[],
  args: {
    files: string[];
    pattern: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    levelFilter?: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
  }
): Promise<string> {
  let regex: RegExp;
  try {
    regex = buildRegex(args.pattern, args.isRegex, args.caseSensitive);
  } catch (e) {
    return `Invalid pattern: ${e}`;
  }

  const limit = args.limit ?? 20;
  const levelFilter = args.levelFilter?.map((l) => l.toLowerCase());
  const paths = await resolveFileRefs(args.files, logDir);
  let totalLines = 0;
  let totalFiles = 0;
  const unexpected: Array<{ file: string; timestamp: string; message: string }> = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    totalFiles++;
    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    totalLines += entries.length;

    for (const e of entries) {
      if (levelFilter && !levelFilter.includes(e.line.level.toLowerCase())) continue;
      if (!isInTimeWindow(e.line.timestamp, args.startTime, args.endTime)) continue;
      if (regex.test(e.fullText ?? e.line.raw) || regex.test(e.line.message)) {
        unexpected.push({ file: fileRef, timestamp: e.line.timestamp, message: e.line.message });
        if (unexpected.length >= limit) break;
      }
      regex.lastIndex = 0;
    }
    if (unexpected.length >= limit) break;
  }

  if (unexpected.length === 0) {
    return (
      `CONFIRMED ABSENT: Pattern '${args.pattern}' was NOT found.\n` +
      `Scanned: ${totalFiles} file(s), ${totalLines} log entries.` +
      (args.startTime || args.endTime
        ? `\nTime window: ${args.startTime ?? "start"} → ${args.endTime ?? "end"}`
        : "")
    );
  }

  const lines = [
    `ASSERTION FAILED: Pattern '${args.pattern}' WAS found (${unexpected.length} match(es)).`,
    `Scanned: ${totalFiles} file(s), ${totalLines} log entries.`,
    "",
  ];
  for (const u of unexpected) {
    lines.push(`  ${u.file}  ${u.timestamp}  ${u.message.slice(0, 120)}`);
  }
  return lines.join("\n");
}
