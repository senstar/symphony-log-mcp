import { tryReadLogEntries, resolveFileRefs, appendWarnings } from "../lib/log-reader.js";
import { extractStackTrace, isNativeStackFrame } from "../lib/log-parser.js";
import * as path from "path";

interface FoundStack {
  file: string;
  timestamp: string;
  threadId: string;
  level: string;
  source: string;
  message: string;
  stackFrames: string[];
  isNative: boolean;
  exceptionType: string | null;
}

/** Extract the exception type from a message like "...NullReferenceException: ..." */
function extractExceptionType(message: string): string | null {
  const m = /([A-Z][a-zA-Z]+Exception)/.exec(message);
  return m?.[1] ?? null;
}

export async function toolGetStackTraces(
  logDir: string | string[],
  args: {
    files: string[];
    exceptionFilter?: string;
    limit?: number;
    includeNative?: boolean;
  }
): Promise<string> {
  const limit = args.limit ?? 20;
  const includeNative = args.includeNative ?? true;
  const exFilter = args.exceptionFilter?.toLowerCase();

  const stacks: FoundStack[] = [];
  const paths = await resolveFileRefs(args.files, logDir);
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (entry.continuationLines.length === 0) continue;

      const hasStackFrames = entry.continuationLines.some((l) =>
        /\s+at\s/.test(l)
      );
      if (!hasStackFrames) continue;

      const exType = extractExceptionType(entry.line.message);
      if (exFilter && !exType?.toLowerCase().includes(exFilter) &&
          !entry.line.message.toLowerCase().includes(exFilter)) continue;

      const frames = entry.continuationLines.filter((l) => /\s+at\s/.test(l));
      const native = frames.some(isNativeStackFrame);
      if (!includeNative && native) continue;

      stacks.push({
        file: fileRef,
        timestamp: entry.line.timestamp,
        threadId: entry.line.threadId,
        level: entry.line.level,
        source: entry.line.source,
        message: entry.line.message,
        stackFrames: frames,
        isNative: native,
        exceptionType: exType,
      });
    }
  }

  if (stacks.length === 0) {
    return appendWarnings("No stack traces found" + (exFilter ? ` matching '${exFilter}'` : "") + ".", warnings);
  }

  const shown = stacks.slice(0, limit);
  const out: string[] = [
    `Found ${stacks.length} stack trace(s) (showing ${shown.length}):`,
    "",
  ];

  for (const s of shown) {
    out.push(`[${s.timestamp}] TID ${s.threadId} <${s.level}>${s.isNative ? " [NATIVE]" : ""}`);
    out.push(`  Source:    ${s.source}`);
    if (s.exceptionType) out.push(`  Exception: ${s.exceptionType}`);
    out.push(`  Message:   ${s.message.slice(0, 300)}`);
    out.push(`  Frames (${s.stackFrames.length}):`);
    for (const f of s.stackFrames.slice(0, 8)) {
      out.push(`    ${f.trim()}`);
    }
    if (s.stackFrames.length > 8) out.push(`    ... (${s.stackFrames.length - 8} more frames)`);
    out.push(`  File: ${s.file}`);
    out.push("");
  }

  // Exception type summary
  const typeCounts = new Map<string, number>();
  for (const s of stacks) {
    const k = s.exceptionType ?? "(unknown)";
    typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
  }
  if (typeCounts.size > 0) {
    out.push("--- Exception Summary ---");
    for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(4)}x  ${type}`);
    }
  }

  if (warnings.length > 0) { out.push(""); out.push(...warnings); }
  return out.join("\n");
}
