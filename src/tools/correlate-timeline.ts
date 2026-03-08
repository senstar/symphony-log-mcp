import { readLogEntries, resolveFileRefs, parseLogFilename } from "../lib/log-reader.js";
import { decodePrefix } from "../lib/prefix-map.js";
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
