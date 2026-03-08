/**
 * summarize-health.ts
 *
 * High-level health dashboard for a Symphony server from sccp + IS log files.
 *
 * Shows per-process restart counts and pattern classification (stable / restarted /
 * crash-loop / degrading), plus a top-errors summary and an overall health rating.
 */

import { computeProcessLifetimes } from "./process-lifetimes.js";
import { computeErrorGroups } from "./search-errors.js";
import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import { isSymphonyProcess } from "../lib/symphony-patterns.js";
import * as path from "path";

export interface SummarizeHealthArgs {
  /** sccp log file(s) for process lifetime analysis */
  sccpFiles: string[];
  /** IS / other log files for error counts (optional) */
  errorFiles?: string[];
  startTime?: string;
  endTime?: string;
}

/** Compute the health summary (raw data, no formatting). Called by compare-logs. */
export async function computeHealthSummary(
  logDir: string | string[],
  args: SummarizeHealthArgs
): Promise<{
  processRows: { name: string; restarts: number; pattern: string; peakMem: number; longestRunMins: number; longestRunSparse: boolean }[];
  totalRestarts: number;
  crashLoopCount: number;
  errorCount: number;
  uniquePatterns: number;
  processCount: number;
  topErrors: { count: number; message: string }[];
}> {
  const [lifetimeResult, errorResult] = await Promise.all([
    computeProcessLifetimes(logDir, {
      files: args.sccpFiles,
      symphonyOnly: true,
      showAll: true,
      startTime: args.startTime,
      endTime: args.endTime,
    }),
    args.errorFiles?.length
      ? computeErrorGroups(logDir, {
          files: args.errorFiles,
          deduplicate: true,
          startTime: args.startTime,
          endTime: args.endTime,
        })
      : Promise.resolve(null),
  ]);

  const { lifetimes, processCount } = lifetimeResult;

  // Group by process name
  const byName = new Map<string, typeof lifetimes>();
  for (const lt of lifetimes) {
    const list = byName.get(lt.name) ?? [];
    list.push(lt);
    byName.set(lt.name, list);
  }

  const processRows: { name: string; restarts: number; pattern: string; peakMem: number; longestRunMins: number; longestRunSparse: boolean }[] = [];

  for (const [name, instances] of byName) {
    const restarts = instances.filter(lt => lt.restartedAfter !== undefined).length;

    // Pattern classification
    let pattern: string;
    if (restarts === 0) {
      pattern = "stable";
    } else if (restarts >= 3) {
      pattern = "crash-loop";
    } else {
      pattern = "restarted";
    }

    // Memory-leak / degrading detection: last instance avg mem > 1.5× first
    if (instances.length >= 2) {
      const firstMem = instances[0].avgMem;
      const lastMem = instances[instances.length - 1].avgMem;
      if (firstMem > 0 && lastMem > firstMem * 1.5) pattern = "degrading";
    }

    const peakMem = Math.max(...instances.map(lt => lt.maxMem));

    // Longest single run in minutes (approximated from HH:MM:SS timestamps)
    let longestRunMins = 0;
    // sparse = true when every PID instance has only one sccp snapshot (firstSeen === lastSeen)
    let longestRunSparse = true;
    for (const lt of instances) {
      if (lt.firstSeen !== lt.lastSeen) longestRunSparse = false;
      const toMs = (ts: string): number => {
        const parts = ts.split(":").map(Number);
        return ((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)) * 1000;
      };
      const runMins = Math.max(0, toMs(lt.lastSeen) - toMs(lt.firstSeen)) / 60_000;
      if (runMins > longestRunMins) longestRunMins = runMins;
    }

    processRows.push({ name, restarts, pattern, peakMem, longestRunMins, longestRunSparse });
  }

  processRows.sort((a, b) => b.restarts - a.restarts || a.name.localeCompare(b.name));

  const totalRestarts = processRows.reduce((s, r) => s + r.restarts, 0);
  const crashLoopCount = processRows.filter(r => r.pattern === "crash-loop").length;
  const errorCount = errorResult
    ? [...errorResult.groups.values()].reduce((s, g) => s + g.count, 0)
    : 0;
  const uniquePatterns = errorResult ? errorResult.groups.size : 0;

  // Pre-compute top error messages so toolSummarizeHealth doesn't need a second call
  const topErrors: { count: number; message: string }[] = errorResult
    ? [...errorResult.groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map(g => ({ count: g.count, message: g.first.line.message }))
    : [];

  return { processRows, totalRestarts, crashLoopCount, errorCount, uniquePatterns, processCount, topErrors };
}

/** Format a health summary for display. */
export async function toolSummarizeHealth(
  logDir: string | string[],
  args: SummarizeHealthArgs
): Promise<string> {
  const { processRows, totalRestarts, crashLoopCount, errorCount, uniquePatterns, processCount, topErrors } =
    await computeHealthSummary(logDir, args);

  const out: string[] = [
    "═".repeat(60),
    "  SYMPHONY HEALTH SUMMARY",
    "═".repeat(60),
    "",
  ];

  // ── Process table ─────────────────────────────────────────────────────────
  out.push(`PROCESSES  (${processCount} tracked)`);
  out.push(
    `${"Process".padEnd(35)} ${"Restarts".padStart(8)}  ${"Pattern".padEnd(12)}  ${"Peak Mem".padStart(9)}  Longest Run`
  );
  out.push("─".repeat(85));

  for (const row of processRows) {
    const icon =
      row.pattern === "stable" ? "✓"
      : row.pattern === "crash-loop" ? "✗"
      : row.pattern === "degrading" ? "↑"
      : "!";
    const runStr = row.longestRunSparse
      ? "< 2 min *"
      : `${Math.round(row.longestRunMins)} min`;
    out.push(
      `${(icon + " " + row.name).slice(0, 35).padEnd(35)} ${String(row.restarts).padStart(8)}  ${row.pattern.padEnd(12)}  ${(row.peakMem.toFixed(1) + " MB").padStart(9)}  ${runStr}`
    );
  }

  if (processRows.some(r => r.longestRunSparse)) {
    out.push("  * Longest run estimated from sccp snapshot intervals (~2 min resolution)");
  }
  out.push("");

  // ── Error summary ─────────────────────────────────────────────────────────
  if (errorCount > 0 || uniquePatterns > 0) {
    out.push(`ERRORS  (${errorCount} total occurrences, ${uniquePatterns} unique patterns)`);
    out.push("─".repeat(85));

    for (const e of topErrors) {
      out.push(`  ${String(e.count).padStart(5)}×  ${e.message.slice(0, 75)}`);
    }
    out.push("");
  }

  // ── Overall rating ────────────────────────────────────────────────────────
  let health: string;
  if (crashLoopCount > 0 || totalRestarts >= 5) {
    health = "CRITICAL";
  } else if (totalRestarts > 0 || errorCount > 50) {
    health = "DEGRADED";
  } else {
    health = "HEALTHY";
  }

  out.push("═".repeat(60));
  out.push(`  OVERALL HEALTH: ${health}`);
  out.push(`  Restarts: ${totalRestarts}   Crash-loops: ${crashLoopCount}   Error occurrences: ${errorCount}`);
  out.push("═".repeat(60));

  return out.join("\n");
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Memory & CPU trend analysis from raw sccp snapshots
 * ────────────────────────────────────────────────────────────────────────── */

interface TrendSnapshot {
  time: string;   // HH:MM:SS from log timestamp
  mem: number;    // MB
  cpu: number;    // %
}

interface ProcessTrend {
  name: string;
  firstSnapshot: string;
  lastSnapshot: string;
  firstMem: number;
  lastMem: number;
  peakMem: number;
  avgMem: number;
  avgCpu: number;
  peakCpu: number;
  growthPct: number;
  snapshotCount: number;
}

const SCCP_RE = /^\s*(.+?)\s+PID\(\s*(\d+)\s*\):\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([\d.]+)\s+[\d.]+\s+(\d+)%\s+(\d{2}\/\d{2}\s+\d{2}:\d{2})/;

function normaliseTrendName(name: string): string {
  return name.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+/g, " ").trim();
}

export async function toolMemoryTrends(
  logDir: string | string[],
  args: {
    sccpFiles: string[];
    filter?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
  }
): Promise<string> {
  const limit = args.limit ?? 50;
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const resolved = await resolveFileRefs(args.sccpFiles, logDir);

  // Collect snapshots keyed by normalised process name
  const byProcess = new Map<string, TrendSnapshot[]>();

  for (const file of resolved) {
    const entries = await readLogEntries(file);
    for (const entry of entries) {
      if (args.startTime || args.endTime) {
        if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      }
      const m = SCCP_RE.exec(entry.line.message);
      if (!m) continue;

      const rawName = m[1].trim();
      const name = normaliseTrendName(rawName);

      if (!isSymphonyProcess(name)) continue;
      if (args.filter && !name.toLowerCase().includes(args.filter.toLowerCase())) continue;

      const snap: TrendSnapshot = {
        time: entry.line.timestamp,
        mem: parseFloat(m[3]),
        cpu: parseInt(m[4], 10),
      };

      const list = byProcess.get(name) ?? [];
      list.push(snap);
      byProcess.set(name, list);
    }
  }

  if (byProcess.size === 0) {
    return "No sccp process data found in the specified files.";
  }

  // Build trend records
  const trends: ProcessTrend[] = [];
  let totalSnapshots = 0;
  let globalFirst = "";
  let globalLast = "";

  for (const [name, snaps] of byProcess) {
    if (snaps.length === 0) continue;
    totalSnapshots += snaps.length;

    const firstSnap = snaps[0];
    const lastSnap = snaps[snaps.length - 1];

    let sumMem = 0;
    let sumCpu = 0;
    let peakMem = 0;
    let peakCpu = 0;
    for (const s of snaps) {
      sumMem += s.mem;
      sumCpu += s.cpu;
      if (s.mem > peakMem) peakMem = s.mem;
      if (s.cpu > peakCpu) peakCpu = s.cpu;
    }

    const avgMem = sumMem / snaps.length;
    const avgCpu = sumCpu / snaps.length;
    const growthPct = firstSnap.mem > 0
      ? ((lastSnap.mem - firstSnap.mem) / firstSnap.mem) * 100
      : 0;

    if (!globalFirst || firstSnap.time < globalFirst) globalFirst = firstSnap.time;
    if (!globalLast || lastSnap.time > globalLast) globalLast = lastSnap.time;

    trends.push({
      name,
      firstSnapshot: firstSnap.time,
      lastSnapshot: lastSnap.time,
      firstMem: firstSnap.mem,
      lastMem: lastSnap.mem,
      peakMem,
      avgMem,
      avgCpu,
      peakCpu,
      growthPct,
      snapshotCount: snaps.length,
    });
  }

  // Sort by growthPct descending
  trends.sort((a, b) => b.growthPct - a.growthPct);
  const display = trends.slice(0, limit);

  // Format output
  const out: string[] = [
    "═".repeat(65),
    "  MEMORY & CPU TRENDS  (sccp snapshot analysis)",
    "═".repeat(65),
    "",
    `  ${trends.length} processes tracked across ${totalSnapshots} snapshots, time span ${globalFirst} → ${globalLast}`,
    "",
    `  ${ "Process".padEnd(35)} ${ "Start Mem".padStart(10)} ${ "End Mem".padStart(10)} ${ "Peak Mem".padStart(10)} ${ "Growth".padStart(8)} ${ "Avg CPU".padStart(8)}`,
    "  " + "─".repeat(83),
  ];

  for (const t of display) {
    const flag = t.growthPct > 50 ? "⚠" : " ";
    const name = (flag + " " + t.name).slice(0, 35).padEnd(35);
    const startMem = (t.firstMem.toFixed(1) + " MB").padStart(10);
    const endMem = (t.lastMem.toFixed(1) + " MB").padStart(10);
    const peakMem = (t.peakMem.toFixed(1) + " MB").padStart(10);
    const growth = (t.growthPct >= 0 ? "+" : "") + t.growthPct.toFixed(1) + "%";
    const avgCpu = (Math.round(t.avgCpu) + "%").padStart(8);
    out.push(`  ${name} ${startMem} ${endMem} ${peakMem} ${growth.padStart(8)} ${avgCpu}`);
  }

  if (trends.some(t => t.growthPct > 50)) {
    out.push("");
    out.push("  ⚠ = memory growth > 50% (potential leak)");
  }

  return out.join("\n");
}
