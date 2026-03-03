import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import type { LogEntry } from "../lib/log-parser.js";
import * as path from "path";

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
    const flags = args.caseSensitive ? "g" : "gi";
    regex = args.isRegex
      ? new RegExp(args.pattern, flags)
      : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
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
