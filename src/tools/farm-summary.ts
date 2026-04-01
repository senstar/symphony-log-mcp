/**
 * farm-summary.ts
 *
 * Farm-wide analysis tool — scans a parent directory containing multiple
 * Symphony server log packages and produces an aggregated dashboard.
 *
 * This eliminates the need to manually sym_open + sym_triage each server
 * when investigating a multi-server farm.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { computeHealthSummary } from "./summarize-health.js";
import { computeErrorGroups } from "./search-errors.js";
import { listLogFiles, tryReadLogEntries, resolveFileRefs } from "../lib/log-reader.js";
import { summarizeProcessNames } from "./triage.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FarmArgs {
  parentDir: string;
  mode: "dashboard" | "errors" | "topology" | "cameras" | "connectivity";
  limit?: number;
}

interface ServerSummary {
  name: string;
  logDir: string;
  health: string;
  errors: number;
  uniquePatterns: number;
  topError: string;
  topErrors: { count: number; message: string }[];
  crashLoops: number;
  restarts: number;
  processCount: number;
  cameraCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a path, resolve to the Log/ or Logs/ subdirectory if it exists,
 * otherwise return the path itself if it has log files.
 */
async function resolveLogDir(dir: string): Promise<string | null> {
  // Check for Log/ or Logs/ subdirectory
  for (const sub of ["Log", "Logs"]) {
    const candidate = path.join(dir, sub);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch { /* not found */ }
  }
  // Check if the directory itself contains log files
  try {
    const entries = await fs.readdir(dir);
    if (entries.some(e => /^[a-zA-Z]+-\d{6}_\d+\.txt$/i.test(e))) return dir;
  } catch { /* ignore */ }
  return null;
}

/** Extract a short server name from directory name */
function extractServerName(dirName: string): string {
  // SymphonyLog-server5001-260327-121036 → server5001
  const m = /SymphonyLog-([^-]+(?:-[^-]+)?)-\d{6}-\d{6}/i.exec(dirName);
  if (m) return m[1];
  // server5023-full → server5023-full
  return dirName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────────────────────

async function gatherServerSummaries(parentDir: string): Promise<ServerSummary[]> {
  const entries = await fs.readdir(parentDir, { withFileTypes: true });
  const serverDirs = entries.filter(e => e.isDirectory());

  const summaries: ServerSummary[] = [];

  for (const entry of serverDirs) {
    const fullPath = path.join(parentDir, entry.name);
    const logDir = await resolveLogDir(fullPath);
    if (!logDir) continue;

    const serverName = extractServerName(entry.name);

    // Count cameras by looking for cs* prefixed files
    const logFiles = await listLogFiles(logDir);
    const cameraFiles = new Set(logFiles.filter(f => f.prefix.startsWith("cs")).map(f => f.prefix));

    let health = "UNKNOWN";
    let errors = 0;
    let uniquePatterns = 0;
    let topError = "";
    let topErrors: { count: number; message: string }[] = [];
    let crashLoops = 0;
    let restarts = 0;
    let processCount = 0;

    // Run health analysis
    try {
      const h = await computeHealthSummary(logDir, { sccpFiles: ["sccp"], errorFiles: ["is"] });
      processCount = h.processCount;
      restarts = h.totalRestarts;
      crashLoops = h.crashLoopCount;
      errors = h.errorCount;
      uniquePatterns = h.uniquePatterns;
      topError = h.topErrors[0]?.message?.slice(0, 80) ?? "";
      topErrors = h.topErrors.slice(0, 5).map(e => ({ count: e.count, message: e.message }));

      if (crashLoops > 0 || restarts >= 5) health = "CRITICAL";
      else if (restarts > 0 || errors > 50) health = "DEGRADED";
      else health = "HEALTHY";
    } catch {
      health = "ERROR";
    }

    summaries.push({
      name: serverName,
      logDir,
      health,
      errors,
      uniquePatterns,
      topError,
      topErrors,
      crashLoops,
      restarts,
      processCount,
      cameraCount: cameraFiles.size,
    });
  }

  // Sort: CRITICAL first, then DEGRADED, then HEALTHY
  const order: Record<string, number> = { CRITICAL: 0, DEGRADED: 1, ERROR: 2, HEALTHY: 3, UNKNOWN: 4 };
  summaries.sort((a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9));

  return summaries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function buildFarmAggregation(summaries: ServerSummary[]): string[] {
  const out: string[] = [];
  const total = summaries.length;

  // --- Farm-level health assessment ---
  const critical = summaries.filter(s => s.health === "CRITICAL");
  const degraded = summaries.filter(s => s.health === "DEGRADED");
  const healthy = summaries.filter(s => s.health === "HEALTHY");
  const errored = summaries.filter(s => s.health === "ERROR");

  let farmHealth: string;
  const issues: string[] = [];

  if (critical.length > 0) {
    farmHealth = "CRITICAL";
    issues.push(`${critical.length}/${total} servers critical`);
  } else if (degraded.length > 0 || errored.length > 0) {
    farmHealth = "WARNING";
    if (degraded.length > 0) issues.push(`${degraded.length}/${total} servers degraded`);
    if (errored.length > 0) issues.push(`${errored.length}/${total} servers errored`);
  } else {
    farmHealth = "HEALTHY";
  }

  const crashLoopServers = summaries.filter(s => s.crashLoops > 0);
  if (crashLoopServers.length > 0) {
    issues.push(`crash loops on ${crashLoopServers.length} server(s)`);
  }
  const highRestartServers = summaries.filter(s => s.restarts >= 5);
  if (highRestartServers.length > 0) {
    issues.push(`high restarts on ${highRestartServers.length} server(s)`);
  }

  const statusLine = issues.length > 0
    ? `FARM HEALTH: ${farmHealth} — ${issues.join(", ")}`
    : `FARM HEALTH: ${farmHealth} — all ${total} servers healthy`;

  out.push(statusLine);
  out.push("");

  // --- Aggregated metrics ---
  const totalErrors = summaries.reduce((s, x) => s + x.errors, 0);
  const avgErrors = total > 0 ? Math.round(totalErrors / total) : 0;
  const minErrors = Math.min(...summaries.map(s => s.errors));
  const maxErrors = Math.max(...summaries.map(s => s.errors));
  const totalRestarts = summaries.reduce((s, x) => s + x.restarts, 0);
  const totalCrashLoops = summaries.reduce((s, x) => s + x.crashLoops, 0);

  out.push("Aggregated Metrics:");
  out.push(`  Errors:      total ${totalErrors}  avg ${avgErrors}  min ${minErrors}  max ${maxErrors}`);
  out.push(`  Restarts:    ${totalRestarts} total across ${summaries.filter(s => s.restarts > 0).length}/${total} servers`);
  if (totalCrashLoops > 0) {
    out.push(`  Crash Loops: ${totalCrashLoops} total across ${crashLoopServers.length}/${total} servers`);
  }
  out.push("");

  // --- Cross-server pattern detection ---
  const errorPatternMap = new Map<string, string[]>();
  for (const s of summaries) {
    for (const err of s.topErrors) {
      const key = err.message.slice(0, 60).trim();
      if (!key) continue;
      const servers = errorPatternMap.get(key) ?? [];
      if (!servers.includes(s.name)) servers.push(s.name);
      errorPatternMap.set(key, servers);
    }
  }

  const crossServerPatterns = [...errorPatternMap.entries()]
    .filter(([, servers]) => servers.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  const issueGroups: { label: string; servers: string[] }[] = [];
  if (crashLoopServers.length > 0) {
    issueGroups.push({ label: "Crash loops", servers: crashLoopServers.map(s => s.name) });
  }
  if (highRestartServers.length > 0) {
    issueGroups.push({ label: "High restarts (≥5)", servers: highRestartServers.map(s => s.name) });
  }
  const highErrorServers = summaries.filter(s => s.errors > 50);
  if (highErrorServers.length > 0) {
    issueGroups.push({ label: "High error count (>50)", servers: highErrorServers.map(s => s.name) });
  }

  if (crossServerPatterns.length > 0 || issueGroups.length > 0) {
    out.push("Cross-Server Patterns:");
    out.push("─".repeat(80));
    for (const { label, servers } of issueGroups) {
      out.push(`  ${label}: ${servers.length}/${total} servers — ${servers.join(", ")}`);
    }
    if (crossServerPatterns.length > 0) {
      if (issueGroups.length > 0) out.push("");
      out.push("  Common errors across servers:");
      for (const [pattern, servers] of crossServerPatterns.slice(0, 5)) {
        out.push(`    ${servers.length}/${total} servers: ${pattern}`);
        out.push(`      Affected: ${servers.join(", ")}`);
      }
    }
    out.push("");
  }

  return out;
}

function formatDashboard(summaries: ServerSummary[]): string {
  const out: string[] = [];
  const total = summaries.length;
  const critical = summaries.filter(s => s.health === "CRITICAL").length;
  const degraded = summaries.filter(s => s.health === "DEGRADED").length;
  const healthy = summaries.filter(s => s.health === "HEALTHY").length;
  const totalCameras = summaries.reduce((sum, s) => sum + s.cameraCount, 0);
  const totalErrors = summaries.reduce((sum, s) => sum + s.errors, 0);
  const totalCrashLoops = summaries.reduce((sum, s) => sum + s.crashLoops, 0);

  out.push("═".repeat(80));
  out.push("  FARM DASHBOARD");
  out.push("═".repeat(80));
  out.push("");

  // Farm-wide aggregation (overview first)
  out.push(...buildFarmAggregation(summaries));

  out.push(`  Servers: ${total}  |  Cameras: ${totalCameras}  |  Total Errors: ${totalErrors}`);
  out.push(`  Health:  ${critical} CRITICAL  ${degraded} DEGRADED  ${healthy} HEALTHY`);
  if (totalCrashLoops > 0) out.push(`  Crash-Loops: ${totalCrashLoops} process(es) across farm`);
  out.push("");
  out.push("─".repeat(80));
  out.push(
    `${"Server".padEnd(20)} ${"Health".padEnd(10)} ${"Errors".padStart(6)} ${"Ptrn".padStart(5)} ${"CrashL".padStart(6)} ${"Cam".padStart(4)}  Top Error`
  );
  out.push("─".repeat(80));

  for (const s of summaries) {
    const icon = s.health === "CRITICAL" ? "✗" : s.health === "DEGRADED" ? "~" : "✓";
    out.push(
      `${(icon + " " + s.name).padEnd(20)} ${s.health.padEnd(10)} ${String(s.errors).padStart(6)} ${String(s.uniquePatterns).padStart(5)} ${String(s.crashLoops).padStart(6)} ${String(s.cameraCount).padStart(4)}  ${s.topError.slice(0, 40)}`
    );
  }
  out.push("═".repeat(80));
  return out.join("\n");
}

async function formatFarmErrors(summaries: ServerSummary[], parentDir: string, limit: number): Promise<string> {
  const out: string[] = [];
  out.push("═".repeat(80));
  out.push("  FARM-WIDE ERROR AGGREGATION");
  out.push("═".repeat(80));
  out.push("");

  // Gather errors from all servers
  const globalErrors = new Map<string, { count: number; servers: string[] }>();

  for (const s of summaries) {
    try {
      const result = await computeErrorGroups(s.logDir, { files: ["is"], deduplicate: true });
      for (const [fp, g] of result.groups) {
        const existing = globalErrors.get(fp);
        if (existing) {
          existing.count += g.count;
          if (!existing.servers.includes(s.name)) existing.servers.push(s.name);
        } else {
          globalErrors.set(fp, { count: g.count, servers: [s.name] });
        }
      }
    } catch { /* skip server */ }
  }

  // Sort by frequency
  const sorted = [...globalErrors.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit);

  // Farm-wide errors (appear on majority of servers)
  const farmWide = sorted.filter(([, v]) => v.servers.length >= Math.ceil(summaries.length * 0.5));
  const serverSpecific = sorted.filter(([, v]) => v.servers.length < Math.ceil(summaries.length * 0.5));

  if (farmWide.length > 0) {
    out.push(`FARM-WIDE ERRORS (appearing on ${Math.ceil(summaries.length * 0.5)}+ servers):`);
    out.push("─".repeat(80));
    for (const [fp, info] of farmWide) {
      out.push(`  ${String(info.count).padStart(6)}×  [${info.servers.length} servers]  ${fp.slice(0, 60)}`);
    }
    out.push("");
  }

  if (serverSpecific.length > 0) {
    out.push("SERVER-SPECIFIC ERRORS:");
    out.push("─".repeat(80));
    for (const [fp, info] of serverSpecific.slice(0, 20)) {
      out.push(`  ${String(info.count).padStart(6)}×  [${info.servers.join(", ")}]  ${fp.slice(0, 50)}`);
    }
  }

  out.push("═".repeat(80));
  return out.join("\n");
}

function formatTopology(summaries: ServerSummary[]): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  FARM TOPOLOGY");
  out.push("═".repeat(60));
  out.push("");

  for (const s of summaries) {
    const icon = s.health === "CRITICAL" ? "✗" : s.health === "DEGRADED" ? "~" : "✓";
    out.push(`${icon} ${s.name}`);
    out.push(`    Processes: ${s.processCount}  Cameras: ${s.cameraCount}  Restarts: ${s.restarts}`);
    out.push(`    Log dir: ${s.logDir}`);
    out.push("");
  }
  out.push("═".repeat(60));
  return out.join("\n");
}

function formatCameras(summaries: ServerSummary[]): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  FARM CAMERA DISTRIBUTION");
  out.push("═".repeat(60));
  out.push("");

  let totalCameras = 0;
  for (const s of summaries) {
    if (s.cameraCount > 0) {
      out.push(`  ${s.name.padEnd(20)} ${String(s.cameraCount).padStart(4)} cameras  ${s.health}`);
      totalCameras += s.cameraCount;
    }
  }
  out.push("─".repeat(60));
  out.push(`  ${"TOTAL".padEnd(20)} ${String(totalCameras).padStart(4)} cameras`);
  out.push("═".repeat(60));
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity analysis — NxN ALIVE matrix
// ─────────────────────────────────────────────────────────────────────────────

const RE_ALIVE_SEND_FARM = /(?:Sending|Sent)\s+ALIVE\s*(?:---?>|→)\s*([\d,\s]+)/i;
const RE_ALIVE_RECV_FARM = /Received\s+ALIVE\s*(?:<---|←)\s*(\d+)/i;

async function formatConnectivity(summaries: ServerSummary[]): Promise<string> {
  const out: string[] = [];
  out.push("═".repeat(80));
  out.push("  FARM CONNECTIVITY — ALIVE MATRIX");
  out.push("═".repeat(80));
  out.push("");

  // For each server directory, scan IS logs for ALIVE send/receive counts
  interface ServerComm {
    name: string;
    sendTargets: Map<string, number>;   // server ID → count
    recvSources: Map<string, number>;   // server ID → count
    totalSent: number;
    totalRecv: number;
  }

  const serverComms: ServerComm[] = [];
  const allServerIds = new Set<string>();

  for (const s of summaries) {
    const comm: ServerComm = {
      name: s.name,
      sendTargets: new Map(),
      recvSources: new Map(),
      totalSent: 0,
      totalRecv: 0,
    };

    try {
      const paths = await resolveFileRefs(["is"], s.logDir);
      for (const fullPath of paths) {
        const entries = await tryReadLogEntries(fullPath, []);
        if (!entries) continue;

        for (const entry of entries) {
          const msg = entry.line.message;

          const sendMatch = RE_ALIVE_SEND_FARM.exec(msg);
          if (sendMatch) {
            comm.totalSent++;
            const ids = sendMatch[1].split(/[,\s]+/).filter(id => /^\d+$/.test(id.trim()));
            for (const id of ids) {
              const tid = id.trim();
              comm.sendTargets.set(tid, (comm.sendTargets.get(tid) ?? 0) + 1);
              allServerIds.add(tid);
            }
          }

          const recvMatch = RE_ALIVE_RECV_FARM.exec(msg);
          if (recvMatch) {
            comm.totalRecv++;
            const sid = recvMatch[1].trim();
            comm.recvSources.set(sid, (comm.recvSources.get(sid) ?? 0) + 1);
            allServerIds.add(sid);
          }
        }
      }
    } catch { /* skip */ }

    serverComms.push(comm);

    // Try to extract own server ID from name (e.g., "server5023" → "5023")
    const idMatch = /(\d{4,5})/.exec(s.name);
    if (idMatch) allServerIds.add(idMatch[1]);
  }

  const sortedIds = [...allServerIds].sort();

  // Summary per server
  out.push("Per-Server Communication:");
  out.push("─".repeat(80));
  out.push(`${"Server".padEnd(20)} ${"Sent".padStart(8)} ${"Recv".padStart(8)} ${"Status".padEnd(20)}`);
  out.push("─".repeat(80));

  const isolated: string[] = [];
  for (const sc of serverComms) {
    let status: string;
    if (sc.totalSent > 0 && sc.totalRecv === 0) {
      status = "⚠️ ISOLATED (one-way)";
      isolated.push(sc.name);
    } else if (sc.totalSent === 0 && sc.totalRecv === 0) {
      status = "— standalone";
    } else {
      status = "✓ bidirectional";
    }
    out.push(`${sc.name.padEnd(20)} ${String(sc.totalSent).padStart(8)} ${String(sc.totalRecv).padStart(8)} ${status}`);
  }
  out.push("");

  // Alerts
  if (isolated.length > 0) {
    out.push(`⚠️  ${isolated.length} ISOLATED SERVER(S): ${isolated.join(", ")}`);
    out.push("    These servers send ALIVE but receive none — likely blocked by firewall.");
    out.push("");
  }

  // Who-sees-whom matrix (compact)
  if (sortedIds.length > 0 && sortedIds.length <= 20) {
    out.push("ALIVE Receives Matrix (rows=receiver, cols=sender):");
    out.push("─".repeat(80));
    const shortIds = sortedIds.map(id => id.slice(-4));
    out.push(`${"".padEnd(20)} ${shortIds.map(id => id.padStart(6)).join("")}`);

    for (const sc of serverComms) {
      const idMatch = /(\d{4,5})/.exec(sc.name);
      const ownId = idMatch?.[1];
      const row = sortedIds.map(sid => {
        if (sid === ownId) return "  self";
        const count = sc.recvSources.get(sid) ?? 0;
        return count > 0 ? String(count).padStart(6) : "     -";
      });
      out.push(`${sc.name.padEnd(20)} ${row.join("")}`);
    }
    out.push("");
  }

  out.push("═".repeat(80));
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function toolFarmSummary(
  _logDir: string | string[],
  args: FarmArgs,
): Promise<string> {
  const { parentDir, mode, limit = 50 } = args;

  // Validate parentDir
  try {
    const stat = await fs.stat(parentDir);
    if (!stat.isDirectory()) return `Error: '${parentDir}' is not a directory.`;
  } catch {
    return `Error: '${parentDir}' does not exist or is not accessible.`;
  }

  const summaries = await gatherServerSummaries(parentDir);
  if (summaries.length === 0) {
    return `No server log packages found in '${parentDir}'. Expected directories containing Log/ or Logs/ subdirectories with Symphony log files.`;
  }

  switch (mode) {
    case "dashboard":
      return formatDashboard(summaries);
    case "errors":
      return await formatFarmErrors(summaries, parentDir, limit);
    case "topology":
      return formatTopology(summaries);
    case "cameras":
      return formatCameras(summaries);
    case "connectivity":
      return await formatConnectivity(summaries);
    default:
      return `Unknown mode '${mode}'. Use: dashboard, errors, topology, cameras, connectivity`;
  }
}
