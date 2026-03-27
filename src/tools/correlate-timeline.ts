import { readLogEntries, resolveFileRefs, parseLogFilename, isInTimeWindow } from "../lib/log-reader.js";
import { decodePrefix } from "../lib/prefix-map.js";
import { timestampToMs } from "../lib/log-parser.js";
import type { LogEntry } from "../lib/log-parser.js";
import * as path from "path";

interface TaggedEntry {
  entry: LogEntry;
  fileLabel: string;
  prefix: string;
}

export async function toolCorrelateTimelines(
  logDir: string | string[],
  args: {
    files: string[];
    levelFilter?: string[];
    startTime?: string;   // "HH:MM:SS"
    endTime?: string;     // "HH:MM:SS"
    limit?: number;
  }
): Promise<string> {
  const limit = args.limit ?? 500;
  const levelFilter = args.levelFilter?.map((l) => l.toLowerCase());

  // Parse start/end time to comparable strings
  const startCmp = args.startTime ?? "00:00:00";
  const endCmp = args.endTime ?? "23:59:59";

  const all: TaggedEntry[] = [];
  const resolvedPaths = await resolveFileRefs(args.files, logDir);

  // In bug-report mode, determine server label from which dir a file came from
  const serverLabelFor = (fullPath: string): string | undefined => {
    if (!Array.isArray(logDir)) return undefined;
    for (let i = 0; i < logDir.length; i++) {
      if (fullPath.startsWith(logDir[i])) return `Server-${i + 1}`;
    }
    return undefined;
  };

  for (const fullPath of resolvedPaths) {
    const filename = path.basename(fullPath);
    const parsed = parseLogFilename(filename);
    const prefix = parsed?.prefix ?? filename;
    const info = decodePrefix(prefix);
    const serverTag = serverLabelFor(fullPath);
    const label = serverTag
      ? `${serverTag}/${prefix}(${info.description.split(" ")[0]})`
      : `${prefix}(${info.description.split(" ")[0]})`;

    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (levelFilter && !levelFilter.includes(entry.line.level.toLowerCase())) continue;
      if (entry.line.timestamp < startCmp || entry.line.timestamp > endCmp) continue;
      all.push({ entry, fileLabel: label, prefix });
    }
  }

  if (all.length === 0) return "No entries found matching the given criteria.";

  // Sort by timestamp string (HH:MM:SS.mmm sorts lexicographically correctly within a day)
  all.sort((a, b) => a.entry.line.timestamp.localeCompare(b.entry.line.timestamp));

  const shown = all.slice(0, limit);

  const out: string[] = [
    `Correlated ${all.length} entries from ${resolvedPaths.length} file(s) (showing ${shown.length}):`,

    "",
  ];

  for (const { entry, fileLabel } of shown) {
    const l = entry.line;
    const levelTag = l.level === "Error" ? "ERR" : l.level.slice(0, 3).toUpperCase();
    out.push(
      `[${l.timestamp}] ${fileLabel.padEnd(20)} TID ${l.threadId.padStart(5)} [${levelTag}] ` +
      `${l.source}: ${l.message.slice(0, 150)}`
    );
    if (entry.continuationLines.length > 0 && l.level === "Error") {
      out.push(...entry.continuationLines.slice(0, 3).map((c) => `  ${c.trim()}`));
    }
  }

  if (all.length > limit) {
    out.push(`\n... ${all.length - limit} more entries. Narrow the time range or add a level filter.`);
  }

  return out.join("\n");
}

// ── Wave analysis ───────────────────────────────────────────────────────────

interface WaveMatch {
  timestamp: string;
  timestampMs: number;
  fileLabel: string;
  message: string;
}

interface Wave {
  index: number;
  matches: WaveMatch[];
  files: Set<string>;
  startMs: number;
  endMs: number;
}

export async function toolWaveAnalysis(
  logDir: string | string[],
  args: {
    files: string[];
    pattern: string;
    isRegex?: boolean;
    gapSeconds?: number;
    startTime?: string;
    endTime?: string;
    limit?: number;
  }
): Promise<string> {
  const gapMs = (args.gapSeconds ?? 300) * 1000;

  let regex: RegExp;
  try {
    const flags = "gi";
    regex = args.isRegex
      ? new RegExp(args.pattern, flags)
      : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (e) {
    return `Invalid pattern: ${e}`;
  }

  const resolvedPaths = await resolveFileRefs(args.files, logDir);

  // Determine server label for bug-report mode
  const serverLabelFor = (fullPath: string): string | undefined => {
    if (!Array.isArray(logDir)) return undefined;
    for (let i = 0; i < logDir.length; i++) {
      if (fullPath.startsWith(logDir[i])) return `Server-${i + 1}`;
    }
    return undefined;
  };

  // Collect all matches across all files
  const allMatches: WaveMatch[] = [];

  for (const fullPath of resolvedPaths) {
    const filename = path.basename(fullPath);
    const parsed = parseLogFilename(filename);
    const prefix = parsed?.prefix ?? filename;
    const info = decodePrefix(prefix);
    const serverTag = serverLabelFor(fullPath);
    const label = serverTag
      ? `${serverTag}/${prefix}(${info.description.split(" ")[0]})`
      : `${prefix}(${info.description.split(" ")[0]})`;

    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      if (regex.test(entry.fullText ?? entry.line.raw) || regex.test(entry.line.message)) {
        allMatches.push({
          timestamp: entry.line.timestamp,
          timestampMs: entry.line.timestampMs,
          fileLabel: label,
          message: entry.line.message,
        });
      }
      regex.lastIndex = 0;
    }
  }

  if (allMatches.length === 0) {
    return `No matches found for pattern '${args.pattern}' across ${resolvedPaths.length} file(s).`;
  }

  // Sort by timestamp
  allMatches.sort((a, b) => a.timestampMs - b.timestampMs);

  // Group into waves by gap threshold
  const waves: Wave[] = [];
  let currentWave: Wave = {
    index: 1,
    matches: [allMatches[0]],
    files: new Set([allMatches[0].fileLabel]),
    startMs: allMatches[0].timestampMs,
    endMs: allMatches[0].timestampMs,
  };

  for (let i = 1; i < allMatches.length; i++) {
    const m = allMatches[i];
    if (m.timestampMs - currentWave.endMs > gapMs) {
      // New wave
      waves.push(currentWave);
      currentWave = {
        index: waves.length + 2,
        matches: [m],
        files: new Set([m.fileLabel]),
        startMs: m.timestampMs,
        endMs: m.timestampMs,
      };
    } else {
      currentWave.matches.push(m);
      currentWave.files.add(m.fileLabel);
      currentWave.endMs = m.timestampMs;
    }
  }
  waves.push(currentWave);

  // Format output
  const msToTimestamp = (ms: number): string => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    const frac = ms % 1_000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const out: string[] = [
    `Pattern: ${args.pattern}`,
    `Total matches: ${allMatches.length} across ${resolvedPaths.length} file(s)`,
    `Waves: ${waves.length} (gap threshold: ${args.gapSeconds ?? 300}s)`,
    "",
  ];

  const limit = args.limit ?? waves.length;
  for (const wave of waves.slice(0, limit)) {
    const duration = wave.endMs - wave.startMs;
    out.push(`── Wave ${wave.index} ─────────────────────────────────────────`);
    out.push(`  Start:    ${msToTimestamp(wave.startMs)}`);
    out.push(`  End:      ${msToTimestamp(wave.endMs)}`);
    out.push(`  Duration: ${formatDuration(duration)}`);
    out.push(`  Matches:  ${wave.matches.length}`);
    out.push(`  Files:    ${wave.files.size} (${[...wave.files].join(", ")})`);
    out.push(`  First:    ${wave.matches[0].timestamp} ${wave.matches[0].fileLabel}`);
    out.push(`            ${wave.matches[0].message.slice(0, 120)}`);
    if (wave.matches.length > 1) {
      const last = wave.matches[wave.matches.length - 1];
      out.push(`  Last:     ${last.timestamp} ${last.fileLabel}`);
      out.push(`            ${last.message.slice(0, 120)}`);
    }
    out.push("");
  }

  if (waves.length > limit) {
    out.push(`... ${waves.length - limit} more waves.`);
  }

  return out.join("\n");
}
