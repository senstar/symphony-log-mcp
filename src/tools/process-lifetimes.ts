/**
 * Process lifetime tracker — parses sccp (Scheduler – CPU/Memory Stats) log files.
 *
 * sccp logs contain periodic snapshots of every running process.
 * Format from CpuCounter.cpp:
 *   Header: "                          Name PID            Thrd   Hndl   Usr   GDI       Free    MaxFree  Mem(MB)   PF(MB)  CPU%  Start Time  User Time  Kernel Tm"
 *   Body:   "%30s PID(%7d): %5d %6d %5d %5d %10d %10d %8.2f %8.2f %4d%% %02d/%02d %02d:%02d %4d:%02d:%02d %4d:%02d:%02d"
 *
 * Trackers get special naming: "Tracker(NNNN)" via _snprintf(sName, ..., "Tracker(%4d)", camera.TrackerId())
 * Other processes use their exe filename (from GetProcessImageFileName).
 *
 * By tracking PID changes across snapshots we can tell when a process restarted,
 * how long it ran, and what its steady-state memory / CPU usage was.
 *
 * Log file rollover: 5 MB max per file (MAX_FILE_SIZE = 5000000).
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, appendWarnings } from "../lib/log-reader.js";
import { isSymphonyProcess } from "../lib/symphony-patterns.js";
import * as path from "path";

interface ProcessSnapshot {
  snapshotTime: string;   // HH:MM:SS from log line timestamp
  pid: number;
  mem: number;            // MB
  cpu: number;            // percent
  processStart: string;   // "MM/DD HH:MM" from the record itself
}

interface ProcessLifetime {
  name: string;
  pid: number;
  startedAt: string;        // From the sccp start-time column
  firstSeen: string;        // First snapshot timestamp
  lastSeen: string;         // Last snapshot timestamp
  maxMem: number;
  avgMem: number;
  maxCpu: number;
  restartedAfter?: string;  // Snapshot time of the previous PID's last appearance
}

/**
 * Parse a sccp process line from entry.line.message.
 * Format:  "  Name PID(  NNN):   T   H  U  G  FREE  MAXFREE  MEM.MM  PF.MM  CPU%  MM/DD  HH:MM  ..."
 */
function parseSccpLine(message: string): { name: string; pid: number; mem: number; cpu: number; processStart: string } | null {
  // Match:  <name>  PID( <pid> ):  ... <mem.xx>   <pf.xx>   <cpu>%  <MM/DD>  <HH:MM>
  const m = /^\s*(.+?)\s+PID\(\s*(\d+)\s*\):\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([\d.]+)\s+[\d.]+\s+(\d+)%\s+(\d{2}\/\d{2}\s+\d{2}:\d{2})/.exec(message);
  if (!m) return null;
  return {
    name: m[1].trim(),
    pid: parseInt(m[2], 10),
    mem: parseFloat(m[3]),
    cpu: parseInt(m[4], 10),
    processStart: m[5],
  };
}

// Symphony process detection imported from ../lib/symphony-patterns.ts

/**
 * Normalise a process name for grouping.
 * "Tracker(   1)" → "Tracker(1)", etc.
 */
function normaliseName(name: string): string {
  return name.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+/g, " ").trim();
}

export interface ProcessLifetimesArgs {
  files: string[];
  /** Only show Symphony processes (default: true) */
  symphonyOnly?: boolean;
  /** Filter to process names containing this substring */
  filter?: string;
  /** Show all processes, not just those that restarted */
  showAll?: boolean;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/** Compute raw process lifetime records from sccp logs. */
export async function computeProcessLifetimes(
  logDir: string | string[],
  args: ProcessLifetimesArgs,
  warnings?: string[],
): Promise<{ lifetimes: ProcessLifetime[]; processCount: number }> {
  const symphonyOnly = args.symphonyOnly ?? true;

  const byProcess = new Map<string, Map<number, ProcessSnapshot[]>>();
  const paths = await resolveFileRefs(args.files, logDir);
  const warn = warnings ?? [];

  for (const fullPath of paths) {
    const entries = await tryReadLogEntries(fullPath, warn);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const parsed = parseSccpLine(entry.line.message);
      if (!parsed) continue;

      const name = normaliseName(parsed.name);
      if (symphonyOnly && !isSymphonyProcess(name)) continue;
      if (args.filter && !name.toLowerCase().includes(args.filter.toLowerCase())) continue;

      let pids = byProcess.get(name);
      if (!pids) { pids = new Map(); byProcess.set(name, pids); }

      let snaps = pids.get(parsed.pid);
      if (!snaps) { snaps = []; pids.set(parsed.pid, snaps); }

      snaps.push({
        snapshotTime: entry.line.timestamp,
        pid: parsed.pid,
        mem: parsed.mem,
        cpu: parsed.cpu,
        processStart: parsed.processStart,
      });
    }
  }

  const lifetimes: ProcessLifetime[] = [];
  for (const [name, pids] of byProcess) {
    const pidList = [...pids.entries()].sort(
      (a, b) => a[1][0].snapshotTime.localeCompare(b[1][0].snapshotTime)
    );
    for (let i = 0; i < pidList.length; i++) {
      const [pid, snaps] = pidList[i];
      const mems = snaps.map(s => s.mem);
      const cpus = snaps.map(s => s.cpu);
      const lt: ProcessLifetime = {
        name, pid,
        startedAt: snaps[0].processStart,
        firstSeen: snaps[0].snapshotTime,
        lastSeen: snaps[snaps.length - 1].snapshotTime,
        maxMem: Math.max(...mems),
        avgMem: mems.reduce((a, b) => a + b, 0) / mems.length,
        maxCpu: Math.max(...cpus),
      };
      if (i > 0) {
        const prevSnaps = pidList[i - 1][1];
        lt.restartedAfter = prevSnaps[prevSnaps.length - 1].snapshotTime;
      }
      lifetimes.push(lt);
    }
  }

  return { lifetimes, processCount: byProcess.size };
}

export async function toolGetProcessLifetimes(
  logDir: string | string[],
  args: ProcessLifetimesArgs
): Promise<string> {
  const showAll = args.showAll ?? false;
  const limit = args.limit ?? 100;

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return "No sccp log files found.";
  const warnings: string[] = [];

  const { lifetimes, processCount: byProcessSize } = await computeProcessLifetimes(logDir, args, warnings);
  const byProcess = { size: byProcessSize }; // keep reference count

  if (lifetimes.length === 0) {
    return appendWarnings("No process records found. Make sure you are passing sccp-*.txt log files.", warnings);
  }

  // Compatibility shim — all subsequent code uses lifetimes directly
  const byProcessCount = byProcessSize;

  // Filter to restarted processes unless showAll
  const restarted = lifetimes.filter((lt) => lt.restartedAfter !== undefined);
  const display = showAll ? lifetimes : restarted.length > 0 ? restarted : lifetimes;

  // Sort by name then firstSeen
  display.sort((a, b) => a.name.localeCompare(b.name) || a.firstSeen.localeCompare(b.firstSeen));

  const shown = display.slice(0, limit);

  const header = showAll
    ? `Process lifetime summary: ${byProcessCount} process(es) tracked:`
    : restarted.length > 0
    ? `Found ${restarted.length} restart(s) across ${byProcessCount} tracked process(es) (showing ${shown.length}):`
    : `No restarts detected. ${byProcessCount} process(es) tracked (showing ${shown.length}):`;

  const out: string[] = [header, ""];

  for (const lt of shown) {
    const isRestart = lt.restartedAfter !== undefined;
    const icon = isRestart ? "🔄 RESTART" : "  RUNNING";
    out.push(`${icon}  ${lt.name}  PID(${lt.pid})`);
    out.push(`  OS start:     ${lt.startedAt}`);
    out.push(`  First seen:   ${lt.firstSeen}  →  Last seen: ${lt.lastSeen}`);
    if (isRestart) {
      out.push(`  Previous PID last seen: ${lt.restartedAfter}`);
    }
    out.push(`  Memory:  avg ${lt.avgMem.toFixed(1)} MB  max ${lt.maxMem.toFixed(1)} MB   CPU max: ${lt.maxCpu}%`);
    out.push("");
  }

  // Cross-process restart summary
  if (restarted.length > 0) {
    const processesWithRestarts = new Map<string, number>();
    for (const lt of restarted) {
      processesWithRestarts.set(lt.name, (processesWithRestarts.get(lt.name) ?? 0) + 1);
    }
    out.push("--- Restart Summary ---");
    for (const [name, count] of [...processesWithRestarts.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(3)}x  ${name}`);
    }
  }

  if (warnings.length > 0) { out.push(""); out.push(...warnings); }
  return out.join("\n");
}

