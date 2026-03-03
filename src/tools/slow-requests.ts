import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import { parseTookMs } from "../lib/log-parser.js";
import { findSlowHttpRequests } from "./search-http-requests.js";
import * as path from "path";

/** Extract the RPC method name from messages like
 *  "...Request(39)[CallRPC.Farm.Interfaces.IFoo.GetBars] for ip:port took..."
 *  "...Request(2)[WallGetPanels] for ip:port took..."
 * Uses greedy backtracking to always capture the final segment after the last dot.
 */
function extractMethodName(message: string): string | null {
  const m = /\[(?:[^\]]*\.)?(\w+)\]/.exec(message);
  return m?.[1] ?? null;
}

interface SlowRequest {
  file: string;
  timestamp: string;
  threadId: string;
  source: string;
  message: string;
  durationMs: number;
}

export async function toolGetSlowRequests(
  logDir: string | string[],
  args: {
    files: string[];
    thresholdMs?: number;
    limit?: number;
    sortBy?: "duration" | "time";
    groupBy?: "request";
    includeHttp?: boolean;
    startTime?: string;
    endTime?: string;
  }
): Promise<string> {
  const thresholdMs = args.thresholdMs ?? 1000;
  const limit = args.limit ?? 50;
  const sortBy = args.sortBy ?? "duration";

  const slow: SlowRequest[] = [];
  const paths = await resolveFileRefs(args.files, logDir);

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const ms = parseTookMs(entry.line.message);
      if (ms === null || ms < thresholdMs) continue;
      slow.push({
        file: fileRef,
        timestamp: entry.line.timestamp,
        threadId: entry.line.threadId,
        source: entry.line.source,
        message: entry.line.message,
        durationMs: ms,
      });
    }
  }

  // Also scan for slow HTTP-layer requests (RequestLogger entries in IS files)
  if (args.includeHttp) {
    for (const fullPath of paths) {
      const entries = await findSlowHttpRequests(fullPath, thresholdMs, args.startTime, args.endTime);
      for (const e of entries) {
        slow.push({
          file: e.file,
          timestamp: e.timestamp,
          threadId: "-",
          source: "RequestLogger (HTTP)",
          message: `${e.method} ${e.path}  →  ${e.status ?? "?"}  took ${e.durationMs}ms`,
          durationMs: e.durationMs,
        });
      }
    }
  }

  if (slow.length === 0) {
    return `No requests exceeding ${thresholdMs}ms found.`;
  }

  // ---- grouped output ----
  if (args.groupBy === "request") {
    interface MethodGroup {
      count: number;
      totalMs: number;
      maxMs: number;
      examples: SlowRequest[];
      minuteBuckets: Map<string, number>;
    }
    const byMethod = new Map<string, MethodGroup>();
    for (const r of slow) {
      const key = extractMethodName(r.message) ?? r.source ?? "(unknown)";
      const g = byMethod.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, examples: [] as SlowRequest[], minuteBuckets: new Map<string, number>() };
      g.count++;
      g.totalMs += r.durationMs;
      if (r.durationMs > g.maxMs) g.maxMs = r.durationMs;
      if (g.examples.length < 2) g.examples.push(r);
      const minKey = r.timestamp.slice(0, 5); // "HH:MM"
      g.minuteBuckets.set(minKey, (g.minuteBuckets.get(minKey) ?? 0) + 1);
      byMethod.set(key, g);
    }
    const sorted = [...byMethod.entries()].sort((a, b) => b[1].maxMs - a[1].maxMs);
    const out: string[] = [
      `Found ${slow.length} slow request(s) exceeding ${thresholdMs}ms grouped into ${sorted.length} method(s):`,
      "",
    ];
    for (const [method, g] of sorted.slice(0, limit)) {
      const fmt = (ms: number) =>
        ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` :
        ms >= 1_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
      out.push(`${method}`);
      out.push(`  Calls: ${g.count}  Max: ${fmt(g.maxMs)}  Avg: ${fmt(Math.round(g.totalMs / g.count))}`);
      for (const ex of g.examples) {
        out.push(`  [${ex.timestamp}] ${ex.message.slice(0, 180)}`);
      }
      // Time distribution histogram
      const buckets = [...g.minuteBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (buckets.length > 1) {
        const maxC = Math.max(...buckets.map(([, c]) => c));
        const BAR = 24;
        out.push(`  Time distribution (per minute):`);
        for (const [min, cnt] of buckets) {
          const bar = "█".repeat(Math.max(1, Math.round((cnt / maxC) * BAR)));
          out.push(`    ${min}  ${bar.padEnd(BAR + 1)} ${cnt}`);
        }
      }
      out.push("");
    }
    return out.join("\n");
  }

  // ---- flat output ----
  if (sortBy === "duration") {
    slow.sort((a, b) => b.durationMs - a.durationMs);
  } else {
    slow.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  const shown = slow.slice(0, limit);

  const out: string[] = [
    `Found ${slow.length} slow request(s) exceeding ${thresholdMs}ms (showing ${shown.length}, sorted by ${sortBy}):`,
    "",
  ];

  for (const r of shown) {
    const dur =
      r.durationMs >= 60_000
        ? `${(r.durationMs / 60_000).toFixed(1)}min`
        : r.durationMs >= 1_000
        ? `${(r.durationMs / 1000).toFixed(3)}s`
        : `${r.durationMs}ms`;

    out.push(`[${r.timestamp}] ${dur.padStart(9)}  ${r.source}`);
    out.push(`  ${r.message.slice(0, 200)}`);
    out.push(`  File: ${r.file}`);
    out.push("");
  }

  // Summary stats
  const durations = slow.map((r) => r.durationMs);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const max = Math.max(...durations);
  const p95 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] ?? max;

  out.push("--- Statistics ---");
  out.push(`Total: ${slow.length}  Max: ${max}ms  Avg: ${avg.toFixed(0)}ms  P95: ${p95}ms`);

  return out.join("\n");
}
