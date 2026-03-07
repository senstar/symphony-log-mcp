import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import { extractStackTrace, type LogEntry } from "../lib/log-parser.js";
import { fingerprint } from "../lib/fingerprint.js";
import * as path from "path";

export interface ErrorGroup {
  fingerprint: string;
  count: number;
  first: LogEntry;
  last: LogEntry;
  hasStack: boolean;
}

export interface SearchErrorsArgs {
  files: string[];
  deduplicate?: boolean;
  includeStacks?: boolean;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/** Compute deduplicated error groups without formatting. */
export async function computeErrorGroups(
  logDir: string | string[],
  args: SearchErrorsArgs
): Promise<{ groups: Map<string, ErrorGroup>; rawErrors: LogEntry[]; fileCount: number }> {
  const dedup = args.deduplicate ?? true;
  const groups = new Map<string, ErrorGroup>();
  const rawErrors: LogEntry[] = [];
  let fileCount = 0;

  const paths = await resolveFileRefs(args.files, logDir);
  fileCount = paths.length;

  for (const fullPath of paths) {
    let entries: LogEntry[];
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (entry.line.level !== "Error") continue;
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;

      if (!dedup) {
        rawErrors.push(entry);
        continue;
      }

      const fp = fingerprint(entry.line.message);
      const existing = groups.get(fp);
      if (existing) {
        existing.count++;
        existing.last = entry;
        if (!existing.hasStack && entry.continuationLines.length > 0)
          existing.hasStack = true;
      } else {
        groups.set(fp, {
          fingerprint: fp,
          count: 1,
          first: entry,
          last: entry,
          hasStack: entry.continuationLines.length > 0,
        });
      }
    }
  }

  return { groups, rawErrors, fileCount };
}

export async function toolSearchErrors(
  logDir: string | string[],
  args: SearchErrorsArgs
): Promise<string> {
  const dedup = args.deduplicate ?? true;
  const includeStacks = args.includeStacks ?? true;
  const limit = args.limit ?? 100;

  const { groups, rawErrors, fileCount } = await computeErrorGroups(logDir, args);

  if (!dedup) {
    if (rawErrors.length === 0) return "No errors found.";
    const shown = rawErrors.slice(0, limit);
    const out: string[] = [
      `Found ${rawErrors.length} error entry(ies) across ${fileCount} file(s) (showing ${shown.length}):`,
      "",
    ];
    for (const e of shown) {
      out.push(`[${e.line.timestamp}] TID ${e.line.threadId} ${e.line.source}: ${e.line.message}`);
      if (includeStacks && e.continuationLines.length > 0) {
        out.push(...e.continuationLines.slice(0, 10));
      }
      out.push("");
    }
    return out.join("\n");
  }

  // Deduplicated output
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  if (sorted.length === 0) return "No errors found.";

  const shown = sorted.slice(0, limit);
  const out: string[] = [
    `Found ${sorted.length} unique error pattern(s) across ${fileCount} file(s) (showing ${shown.length}):`,
    "",
  ];

  for (const grp of shown) {
    const f = grp.first.line;
    out.push(`COUNT: ${grp.count}  FIRST: ${f.timestamp}  LAST: ${grp.last.line.timestamp}`);
    out.push(`  Source:  ${f.functionalArea ? f.functionalArea + " / " : ""}${f.source}${f.sourceContext ? " [" + f.sourceContext + "]" : ""}`);
    out.push(`  Message: ${f.message}`);
    if (includeStacks && grp.hasStack) {
      const stack = extractStackTrace(grp.first);
      if (stack) {
        const frames = stack.split("\n").slice(1, 6);
        for (const fr of frames) out.push(`    ${fr.trim()}`);
      }
    }
    out.push("");
  }

  return out.join("\n");
}
