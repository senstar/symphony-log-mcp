import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, appendWarnings } from "../lib/log-reader.js";
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
  args: SearchErrorsArgs,
  warnings?: string[],
): Promise<{ groups: Map<string, ErrorGroup>; rawErrors: LogEntry[]; fileCount: number }> {
  const dedup = args.deduplicate ?? true;
  const groups = new Map<string, ErrorGroup>();
  const rawErrors: LogEntry[] = [];
  let fileCount = 0;
  const warn = warnings ?? [];

  const paths = await resolveFileRefs(args.files, logDir);
  fileCount = paths.length;

  for (const fullPath of paths) {
    const entries = await tryReadLogEntries(fullPath, warn);
    if (!entries) continue;

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
  const warnings: string[] = [];

  const { groups, rawErrors, fileCount } = await computeErrorGroups(logDir, args, warnings);

  if (!dedup) {
    if (rawErrors.length === 0) return appendWarnings("No errors found.", warnings);
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
    if (warnings.length > 0) { out.push(""); out.push(...warnings); }
    return out.join("\n");
  }

  // Deduplicated output
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  if (sorted.length === 0) return appendWarnings("No errors found.", warnings);

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

  if (warnings.length > 0) { out.push(""); out.push(...warnings); }
  return out.join("\n");
}


export interface ErrorsByPrefixArgs {
  startTime?: string;
  endTime?: string;
  includeStacks?: boolean;
  limit?: number;
}

/**
 * Batch error search across ALL active log prefixes in a single call.
 * Returns a per-prefix summary so the agent can see all errors at once
 * instead of making N separate sym_search calls.
 */
export async function toolSearchErrorsByPrefix(
  logDir: string | string[],
  args: ErrorsByPrefixArgs
): Promise<string> {
  const { listLogFiles } = await import("../lib/log-reader.js");
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const allFiles = await listLogFiles(dirs);

  // Discover unique prefixes
  const prefixes = [...new Set(allFiles.map(f => f.prefix))].sort();
  if (prefixes.length === 0)
    return "No log files found in active directory.";

  const includeStacks = args.includeStacks ?? false;
  const limit = args.limit ?? 5;
  const out: string[] = [`# Error Summary by Prefix (${prefixes.length} prefixes)`, ""];
  let totalErrors = 0;
  let prefixesWithErrors = 0;

  for (const pfx of prefixes) {
    const warnings: string[] = [];
    const { groups } = await computeErrorGroups(logDir, {
      files: [pfx],
      deduplicate: true,
      includeStacks,
      startTime: args.startTime,
      endTime: args.endTime,
      limit,
    }, warnings);

    const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
    const errorCount = sorted.reduce((sum, g) => sum + g.count, 0);
    totalErrors += errorCount;

    if (sorted.length === 0) continue;
    prefixesWithErrors++;

    const shown = sorted.slice(0, limit);
    out.push(`## ${pfx.toUpperCase()} — ${sorted.length} unique pattern(s), ${errorCount} total`);
    for (const grp of shown) {
      const f = grp.first.line;
      out.push(`- **${grp.count}x** [${f.timestamp}–${grp.last.line.timestamp}] ${f.source}: ${f.message.slice(0, 200)}`);
      if (includeStacks && grp.hasStack) {
        const { extractStackTrace } = await import("../lib/log-parser.js");
        const stack = extractStackTrace(grp.first);
        if (stack) {
          const frames = stack.split("\n").slice(1, 4);
          for (const fr of frames) out.push(`    ${fr.trim()}`);
        }
      }
    }
    if (sorted.length > limit)
      out.push(`  … and ${sorted.length - limit} more pattern(s)`);
    out.push("");
  }

  out.unshift(""); // spacing after header
  out.splice(2, 0, `**${prefixesWithErrors}/${prefixes.length} prefixes** have errors. **${totalErrors} total errors.**`, "");

  return out.join("\n");
}
