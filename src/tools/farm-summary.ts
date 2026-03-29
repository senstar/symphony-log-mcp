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
import { listLogFiles, readLogEntries, resolveFileRefs } from "../lib/log-reader.js";
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
        let entries;
        try { entries = await readLogEntries(fullPath); } catch { continue; }

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
