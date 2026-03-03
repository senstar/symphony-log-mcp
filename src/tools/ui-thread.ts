import { readLogEntries, resolveLogPath } from "../lib/log-reader.js";
import type { LogEntry } from "../lib/log-parser.js";

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
];

/** Identify likely UI thread IDs from patterns of entries */
function guessUiThreadId(entries: LogEntry[]): string | null {
  const threadActivity = new Map<string, number>();
  const threadUiScore = new Map<string, number>();

  for (const e of entries) {
    const tid = e.line.threadId;
    threadActivity.set(tid, (threadActivity.get(tid) ?? 0) + 1);
    if (UI_INDICATORS.some((p) => p.test(e.line.message))) {
      threadUiScore.set(tid, (threadUiScore.get(tid) ?? 0) + 1);
    }
  }

  // Thread with highest UI score (and at least some activity)
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
    file: string;
    threadId?: string;
    lastN?: number;
    fullLog?: boolean;
  }
): Promise<string> {
  const fullPath = resolveLogPath(args.file, logDir);
  const lastN = args.lastN ?? 30;

  let entries: LogEntry[];
  try {
    entries = await readLogEntries(fullPath);
  } catch (e) {
    return `Error reading file: ${e}`;
  }

  let targetThread = args.threadId;

  if (!targetThread) {
    targetThread = guessUiThreadId(entries) ?? undefined;
  }

  const out: string[] = [];

  if (!targetThread) {
    // List all threads with entry counts so user can pick one
    const threadCounts = new Map<string, number>();
    for (const e of entries) {
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

  const threadEntries = entries.filter((e) => e.line.threadId === targetThread);

  out.push(`Thread TID ${targetThread} has ${threadEntries.length} total entries in ${args.file}.`);

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
    out.push(`[${l.timestamp}] <${l.level.padEnd(9)}> ${l.source}: ${l.message.slice(0, 200)}`);
    if (e.continuationLines.length > 0) {
      out.push(...e.continuationLines.slice(0, 4).map((c) => `  ${c.trim()}`));
    }
  }

  // Time gap analysis: if last entry was much earlier than other thread activity, it froze
  if (threadEntries.length > 0 && entries.length > 0) {
    const lastUiMs = threadEntries[threadEntries.length - 1].line.timestampMs;
    const lastAnyMs = entries[entries.length - 1].line.timestampMs;
    const gapMs = lastAnyMs - lastUiMs;
    if (gapMs > 5000) {
      out.push("");
      out.push(
        `⚠ UI thread last logged at ${threadEntries[threadEntries.length - 1].line.timestamp}, ` +
        `but log continues for ${(gapMs / 1000).toFixed(1)}s more — possible UI freeze/deadlock.`
      );
    }
  }

  return out.join("\n");
}
