import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import type { LogEntry } from "../lib/log-parser.js";
import * as path from "path";

/**
 * For AiraExplorer (ae) logs, the UI thread is typically the thread that
 * processes UI events and invokes Dispatcher/Invoke calls. In Symphony's
 * client log, deadlock symptoms appear as the UI thread going silent while
 * other threads continue to log. This tool finds the last N entries from a
 * specific thread, or tries to identify the most-likely main thread by
 * looking for UI-associated activity patterns.
 */

const UI_INDICATORS = [
  /\bDispatcher\b/i,
  /\bDispatcherObject\b/i,
  /\bInvoke\b/i,
  /\bBeginInvoke\b/i,
  /\bUI.*thread\b/i,
  /\bFormLoad\b/i,
  /WinForms/i,
  /\bForm\b.*\.Show/i,
  /\bApplication\.Run\b/i,
  /\bKeyDown\b|\bMouseClick\b|\bButtonClick\b/i,
  /CameraViewVideoModeManager/i,
  /LoadClientLogs/i,
  /\bBinding\b/i,
  /\bDependencyProperty\b/i,
  /\bWPF\b/i,
  /\bMeasureOverride\b|\bArrangeOverride\b/i,
  /\bVisual\b.*\bUpdate/i,
  /\bRenderThread\b/i,
];

/** Identify likely UI thread IDs from patterns of entries */
function guessUiThreadId(entries: LogEntry[]): string | null {
  const threadUiScore = new Map<string, number>();

  for (const e of entries) {
    const tid = e.line.threadId;
    if (UI_INDICATORS.some((p) => p.test(e.line.message))) {
      threadUiScore.set(tid, (threadUiScore.get(tid) ?? 0) + 1);
    }
  }

  // Thread with highest UI score
  let best: string | null = null;
  let bestScore = 0;
  for (const [tid, score] of threadUiScore) {
    if (score > bestScore) {
      bestScore = score;
      best = tid;
    }
  }
  return best;
}

export async function toolGetUiThreadActivity(
  logDir: string | string[],
  args: {
    files: string[];
    threadId?: string;
    lastN?: number;
    fullLog?: boolean;
    freezeThresholdMs?: number;
    startTime?: string;
    endTime?: string;
  }
): Promise<string> {
  const lastN = args.lastN ?? 30;
  const freezeThreshold = args.freezeThresholdMs ?? 5000;

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return `No log files found for: ${args.files.join(", ")}`;

  // Collect entries from all files
  let allEntries: (LogEntry & { sourceFile: string })[] = [];
  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    try {
      const entries = await readLogEntries(fullPath);
      for (const e of entries) {
        if (!isInTimeWindow(e.line.timestamp, args.startTime, args.endTime)) continue;
        allEntries.push({ ...e, sourceFile: fileRef });
      }
    } catch {
      continue;
    }
  }

  if (allEntries.length === 0) {
    return `No log entries found in specified files${args.startTime ? ` within time window ${args.startTime}–${args.endTime ?? "end"}` : ""}.`;
  }

  // Sort by timestampMs
  allEntries.sort((a, b) => a.line.timestampMs - b.line.timestampMs);

  let targetThread = args.threadId;

  if (!targetThread) {
    targetThread = guessUiThreadId(allEntries) ?? undefined;
  }

  const out: string[] = [];

  if (!targetThread) {
    const threadCounts = new Map<string, number>();
    for (const e of allEntries) {
      threadCounts.set(e.line.threadId, (threadCounts.get(e.line.threadId) ?? 0) + 1);
    }
    const sorted = [...threadCounts.entries()].sort((a, b) => b[1] - a[1]);
    out.push("Could not identify UI thread automatically. Thread activity counts:");
    out.push("");
    for (const [tid, count] of sorted.slice(0, 20)) {
      out.push(`  TID ${tid.padStart(6)}  ${count} entries`);
    }
    out.push("");
    out.push("Re-run with threadId set to the desired TID.");
    return out.join("\n");
  }

  const threadEntries = allEntries.filter((e) => e.line.threadId === targetThread);
  const filesLabel = paths.length === 1 ? path.basename(paths[0]) : `${paths.length} files`;

  out.push(`Thread TID ${targetThread} has ${threadEntries.length} total entries across ${filesLabel}.`);

  if (threadEntries.length === 0) {
    out.push(`No entries found for TID ${targetThread}.`);
    return out.join("\n");
  }

  const toShow = args.fullLog ? threadEntries : threadEntries.slice(-lastN);
  const label = args.fullLog ? "All" : `Last ${toShow.length}`;

  out.push(`${label} entries for TID ${targetThread}:`);
  out.push("");

  for (const e of toShow) {
    const l = e.line;
    const fileTag = paths.length > 1 ? ` [${e.sourceFile}]` : "";
    out.push(`[${l.timestamp}] <${l.level.padEnd(9)}> ${l.source}: ${l.message.slice(0, 200)}${fileTag}`);
    if (e.continuationLines.length > 0) {
      out.push(...e.continuationLines.slice(0, 4).map((c) => `  ${c.trim()}`));
    }
  }

  // Intra-thread gap analysis: detect freezes within the UI thread's own log
  const freezes: { from: string; to: string; gapMs: number; sourceFile: string }[] = [];
  for (let i = 1; i < threadEntries.length; i++) {
    const gapMs = threadEntries[i].line.timestampMs - threadEntries[i - 1].line.timestampMs;
    if (gapMs > freezeThreshold) {
      freezes.push({
        from: threadEntries[i - 1].line.timestamp,
        to: threadEntries[i].line.timestamp,
        gapMs,
        sourceFile: threadEntries[i].sourceFile,
      });
    }
  }

  if (freezes.length > 0) {
    out.push("");
    out.push(`⚠ Detected ${freezes.length} UI freeze(s) exceeding ${freezeThreshold}ms:`);
    for (const f of freezes.slice(0, 10)) {
      const dur = f.gapMs >= 60_000
        ? `${(f.gapMs / 60_000).toFixed(1)}min`
        : `${(f.gapMs / 1000).toFixed(1)}s`;
      out.push(`  ${f.from} → ${f.to}  gap ${dur}`);
    }
    if (freezes.length > 10) out.push(`  … (${freezes.length - 10} more)`);
  }

  // Tail-gap analysis: if last UI entry was much earlier than other thread activity
  if (threadEntries.length > 0 && allEntries.length > 0) {
    const lastUiMs = threadEntries[threadEntries.length - 1].line.timestampMs;
    const lastAnyMs = allEntries[allEntries.length - 1].line.timestampMs;
    const gapMs = lastAnyMs - lastUiMs;
    if (gapMs > freezeThreshold) {
      out.push("");
      out.push(
        `⚠ UI thread last logged at ${threadEntries[threadEntries.length - 1].line.timestamp}, ` +
        `but log continues for ${(gapMs / 1000).toFixed(1)}s more — possible UI freeze/deadlock.`
      );
    }
  }

  return out.join("\n");
}
