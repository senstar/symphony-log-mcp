/**
 * triage.ts
 *
 * Automated first-pass diagnosis tool. Runs multiple analyses in parallel
 * and produces a prioritized finding list with drill-down hints.
 */

import { computeHealthSummary } from "./summarize-health.js";
import { computeErrorGroups } from "./search-errors.js";
import { toolGetServiceLifecycle } from "./service-lifecycle.js";
import { toolEventLog } from "./event-log.js";
import { listLogFiles, readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import type { BugReport } from "../lib/bug-report.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "CRITICAL" | "WARNING" | "INFO";

interface Finding {
  severity: Severity;
  category: string;
  message: string;
  drillDown: string;
}

/**
 * Collapse a list like ["Tracker(746)", "Tracker(747)", ..., "Tracker(853)", "infoservice.exe"]
 * into "Tracker(746–853), infoservice.exe" using range notation for consecutive IDs.
 */
/** @internal Exported for testing */
export function summarizeProcessNames(names: string[]): string {
  const TRACKER_RE = /^Tracker\((\d+)\)$/;
  const trackerIds: number[] = [];
  const others: string[] = [];

  for (const n of names) {
    const m = TRACKER_RE.exec(n);
    if (m) trackerIds.push(parseInt(m[1], 10));
    else others.push(n);
  }

  if (trackerIds.length === 0) return names.join(", ");

  trackerIds.sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = trackerIds[0], end = trackerIds[0];
  for (let i = 1; i < trackerIds.length; i++) {
    if (trackerIds[i] === end + 1) {
      end = trackerIds[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}–${end}`);
      start = end = trackerIds[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);

  const trackerSummary = trackerIds.length === 1
    ? `Tracker(${trackerIds[0]})`
    : `${trackerIds.length} Trackers (${ranges.join(", ")})`;

  return others.length > 0
    ? `${others.join(", ")}, ${trackerSummary}`
    : trackerSummary;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Inter-server connectivity checks
// ─────────────────────────────────────────────────────────────────────────────

const RE_SEEMS_FAILED = /###\s*SEEMS\s+FAILED\s*###/i;
const RE_ALIVE_SEND = /(?:Sending|Sent)\s+ALIVE\s*(?:---?>|→)\s*([\d,\s]+)/i;
const RE_ALIVE_RECV = /Received\s+ALIVE\s*(?:<---|←)\s*(\d+)/i;
const RE_FORCE_REFRESH = /ForceServerRefreshDeviceGraph/i;
const RE_DELTA_CACHE = /UpdateDeltaCache/i;
const RE_DOWN_SERVER = /(?:Calling\s+\d+\s+signals\.DownServer\s+for\s+down\s+server\s+(\d+))|(?:(\d+)\s+says\s+(\d+)\s+is\s+down)/i;
const RE_MASTER_CHANGE = /Changing\s+master\s+server\s+from\s+<?(\d+)>?\s+to\s+<?(\d+)>?/i;
const RE_BACK_UP = /###\s*BACK\s+UP\s*###/i;
const RE_SSL_POLICY = /SSL\s+policy:\s+(Remote\w+)/i;
const RE_NO_DISPATCHER = /No\s+message\s+dispatcher.*available\s+to\s+route/i;
const RE_SERVICE_STOP_REQUEST = /Received\s+request\s+to\s+stop\s+(\w+)/i;
const RE_PENDING_CHANGES_TIMEOUT = /WaitForPendingChanges\s*\|.*TimeoutException.*waiting\s+(\S+)/i;
const RE_ADDRESS_ERROR = /Error\s+getting\s+(?:address|FQDN)\s+for\s+id\s+(\d+).*(?:Null\s+or\s+blank\s+address|FormatException)/i;
const RE_CRASH_DUMP = /Saved\s+minidump\s+to\s+(\S+)/i;
const RE_UNHANDLED_EXCEPTION = /Application_ThreadException|CurrentDomain_UnhandledException|MyUnhandledExceptionHandlerTerminator/i;
const RE_DNS_FAILURE = /Unable\s+to\s+resolve\s+server\s+address\s+'([^']+)'/i;
const RE_SESSION_FAILURE = /TokenNotFoundException|InvalidSession(?:Exception|ID)|Seer\.Exceptions\.InvalidSessionException/i;
const RE_DELIVERY_FAILURE = /RequestFailedDelivery|Could\s+not\s+retrieve\s+result/i;
const RE_LOG_LEVEL_CHANGED = /Logging\s+level\s+changed\s+to:\s*(.+)/i;
const RE_UPDATE_SERVER_LOG_LEVEL = /UpdateServerLogLevel\s*\|\s*Updating\s+logging\s+level\s+for\s+(\w+)\s+to:\s*'([^']+)'/i;
const RE_UPDATE_CAMERA_LOG_LEVEL = /UpdateCameraLogLevel\s*\|\s*Updating\s+logging\s+level\s+for\s+camera\s+(\d+)\s+to:\s*'([^']+)'/i;

/** Parsed log level configuration for a single process or camera */
export interface LogLevelInfo {
  /** The declared levels, e.g. "BasicInfo|LogError|MoreInfo|LogDiagnostic|Verbose" */
  levels: string;
  /** Whether diagnostic-grade logging is enabled (MoreInfo + LogDiagnostic present) */
  hasDiagnostic: boolean;
  /** Timestamp of the last level change */
  timestamp: string;
}

export interface ConnectivityFindings {
  seemsFailedServers: string[];
  aliveSendCount: number;
  aliveRecvCount: number;
  aliveTargets: string[];
  hasForceRefresh: boolean;
  isFarmMember: boolean;
  deltaCacheGaps: { from: string; to: string; gapMins: number }[];
  /** Servers reported as DOWN via DownServer RPC, with count per server */
  downServerReports: Map<string, number>;
  /** Master changeover events: {from, to, timestamp} */
  masterChanges: { from: string; to: string; timestamp: string }[];
  /** Servers that recovered (BACK UP), with count */
  backUpServers: string[];
  /** SSL certificate policy issues: type → count */
  sslIssues: Map<string, number>;
  /** "No message dispatcher" overload events */
  noDispatcherCount: number;
  /** Service stop requests: service name → count */
  serviceStopRequests: Map<string, number>;
  /** PendingChanges timeout durations */
  pendingChangesTimeouts: string[];
  /** Servers with missing/blank address config: serverId → count */
  addressErrors: Map<string, number>;
  /** Crash dumps saved (minidump paths) */
  crashDumps: string[];
  /** Unhandled exception / crash events */
  unhandledExceptionCount: number;
  /** DNS resolution failures: hostname → count */
  dnsFailures: Map<string, number>;
  /** Session/token failures */
  sessionFailureCount: number;
  /** Request delivery failures (broader than No message dispatcher) */
  deliveryFailureCount: number;
  /** Log level for the IS process (last declared level) */
  isLogLevel: LogLevelInfo | null;
  /** Log level for the AE/client process (last declared level) */
  aeLogLevel: LogLevelInfo | null;
  /** Per-service log levels from UpdateServerLogLevel: service → LogLevelInfo */
  serverLogLevels: Map<string, LogLevelInfo>;
  /** Per-camera log levels from UpdateCameraLogLevel: cameraId → LogLevelInfo */
  cameraLogLevels: Map<string, LogLevelInfo>;
  /** Observed log level distribution: level name → entry count (heuristic fallback) */
  observedLevels: Map<string, number>;
}

/**
 * Scan IS logs for inter-server connectivity issues.
 * Checks for: SEEMS FAILED warnings, ALIVE send/receive asymmetry,
 * ForceServerRefreshDeviceGraph presence, and DeltaCache polling gaps.
 */
export async function scanConnectivity(
  logDir: string | string[],
  startTime?: string,
  endTime?: string,
): Promise<ConnectivityFindings> {
  const findings: ConnectivityFindings = {
    seemsFailedServers: [],
    aliveSendCount: 0,
    aliveRecvCount: 0,
    aliveTargets: [],
    hasForceRefresh: false,
    isFarmMember: false,
    deltaCacheGaps: [],
    downServerReports: new Map(),
    masterChanges: [],
    backUpServers: [],
    sslIssues: new Map(),
    noDispatcherCount: 0,
    serviceStopRequests: new Map(),
    pendingChangesTimeouts: [],
    addressErrors: new Map(),
    crashDumps: [],
    unhandledExceptionCount: 0,
    dnsFailures: new Map(),
    sessionFailureCount: 0,
    deliveryFailureCount: 0,
    isLogLevel: null,
    aeLogLevel: null,
    serverLogLevels: new Map(),
    cameraLogLevels: new Map(),
    observedLevels: new Map(),
  };

  // Scan IS and AE logs for connectivity/crash/session issues
  const isPaths = await resolveFileRefs(["is"], logDir);
  const aePaths = await resolveFileRefs(["ae"], logDir);
  const paths = [...isPaths, ...aePaths];
  if (paths.length === 0) return findings;

  const isPathSet = new Set(isPaths);
  const deltaCacheTimes: number[] = [];
  const seenSeemsFailed = new Set<string>();
  const aliveTargetSet = new Set<string>();

  for (const fullPath of paths) {
    let entries;
    try { entries = await readLogEntries(fullPath); } catch { continue; }

    const isISFile = isPathSet.has(fullPath);

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, startTime, endTime)) continue;
      const msg = entry.line.message;

      // Track observed log level distribution (for heuristic fallback)
      const level = entry.line.level;
      findings.observedLevels.set(level, (findings.observedLevels.get(level) ?? 0) + 1);

      // Explicit "Logging level changed to:" — last one wins per file type
      const llMatch = RE_LOG_LEVEL_CHANGED.exec(msg);
      if (llMatch) {
        const levels = llMatch[1].trim();
        const info: LogLevelInfo = {
          levels,
          hasDiagnostic: /LogDiagnostic|Diagnost/i.test(levels) && /MoreInfo/i.test(levels),
          timestamp: entry.line.timestamp,
        };
        if (isISFile) findings.isLogLevel = info;
        else findings.aeLogLevel = info;
      }

      // UpdateServerLogLevel — per-service level declaration
      const uslMatch = RE_UPDATE_SERVER_LOG_LEVEL.exec(msg);
      if (uslMatch) {
        const svc = uslMatch[1];
        const levels = uslMatch[2];
        findings.serverLogLevels.set(svc, {
          levels,
          hasDiagnostic: /LogDiagnostic|Diagnost/i.test(levels) && /MoreInfo/i.test(levels),
          timestamp: entry.line.timestamp,
        });
      }

      // UpdateCameraLogLevel — per-camera level declaration
      const uclMatch = RE_UPDATE_CAMERA_LOG_LEVEL.exec(msg);
      if (uclMatch) {
        findings.cameraLogLevels.set(uclMatch[1], {
          levels: uclMatch[2],
          hasDiagnostic: /LogDiagnostic|Diagnost/i.test(uclMatch[2]) && /MoreInfo/i.test(uclMatch[2]),
          timestamp: entry.line.timestamp,
        });
      }

      // SEEMS FAILED — logged at BasicInfo level, not Error
      const sfMatch = RE_SEEMS_FAILED.exec(msg);
      if (sfMatch) {
        // Try to extract server ID: "Server 5001 ### SEEMS FAILED ###"
        const idMatch = /Server\s+(\d+)\s+###/i.exec(msg);
        const key = idMatch ? idMatch[1] : msg.slice(0, 60);
        if (!seenSeemsFailed.has(key)) {
          seenSeemsFailed.add(key);
          findings.seemsFailedServers.push(key);
        }
      }

      // ALIVE sent
      const aliveSend = RE_ALIVE_SEND.exec(msg);
      if (aliveSend) {
        findings.aliveSendCount++;
        findings.isFarmMember = true;
        const ids = aliveSend[1].split(/[,\s]+/).filter(s => /^\d+$/.test(s.trim()));
        for (const id of ids) aliveTargetSet.add(id.trim());
      }

      // ALIVE received
      if (RE_ALIVE_RECV.test(msg)) {
        findings.aliveRecvCount++;
      }

      // ForceServerRefreshDeviceGraph
      if (RE_FORCE_REFRESH.test(msg)) {
        findings.hasForceRefresh = true;
      }

      // UpdateDeltaCache timestamps for gap analysis
      if (RE_DELTA_CACHE.test(msg)) {
        deltaCacheTimes.push(entry.line.timestampMs);
      }

      // DownServer RPC — server reports a peer as down
      const dsMatch = RE_DOWN_SERVER.exec(msg);
      if (dsMatch) {
        // Group 1: "Calling ... DownServer for down server X"
        // Group 2,3: "X says Y is down"
        const downId = dsMatch[1] || dsMatch[3];
        if (downId) {
          findings.downServerReports.set(downId, (findings.downServerReports.get(downId) ?? 0) + 1);
        }
      }

      // Master changeover detection
      const mcMatch = RE_MASTER_CHANGE.exec(msg);
      if (mcMatch) {
        findings.masterChanges.push({
          from: mcMatch[1],
          to: mcMatch[2],
          timestamp: entry.line.timestamp,
        });
      }

      // BACK UP — server recovery (companion to SEEMS FAILED)
      const buMatch = RE_BACK_UP.exec(msg);
      if (buMatch) {
        const idMatch = /Server\s+(\d+)\s+###/i.exec(msg);
        const key = idMatch ? idMatch[1] : msg.slice(0, 60);
        if (!findings.backUpServers.includes(key)) {
          findings.backUpServers.push(key);
        }
      }

      // SSL certificate policy issues
      const sslMatch = RE_SSL_POLICY.exec(msg);
      if (sslMatch) {
        const type = sslMatch[1];
        findings.sslIssues.set(type, (findings.sslIssues.get(type) ?? 0) + 1);
      }

      // No message dispatcher — overload
      if (RE_NO_DISPATCHER.test(msg)) {
        findings.noDispatcherCount++;
      }

      // Service stop request — restart cause classification
      const stopMatch = RE_SERVICE_STOP_REQUEST.exec(msg);
      if (stopMatch) {
        const svc = stopMatch[1];
        findings.serviceStopRequests.set(svc, (findings.serviceStopRequests.get(svc) ?? 0) + 1);
      }

      // PendingChanges timeout — camera API blocking
      const pcMatch = RE_PENDING_CHANGES_TIMEOUT.exec(msg);
      if (pcMatch) {
        findings.pendingChangesTimeouts.push(pcMatch[1]);
      }

      // Address config error — server with null/blank address
      const addrMatch = RE_ADDRESS_ERROR.exec(msg);
      if (addrMatch) {
        const serverId = addrMatch[1];
        findings.addressErrors.set(serverId, (findings.addressErrors.get(serverId) ?? 0) + 1);
      }

      // Crash dump saved — process crashed and wrote minidump
      const crashMatch = RE_CRASH_DUMP.exec(msg);
      if (crashMatch) {
        findings.crashDumps.push(crashMatch[1]);
      }

      // Unhandled exception — process about to crash
      // Check both source (method name) and message — these patterns appear as
      // the source/method in AE logs (e.g., "System\tApplication_ThreadException\t...")
      if (RE_UNHANDLED_EXCEPTION.test(msg) || RE_UNHANDLED_EXCEPTION.test(entry.line.source)) {
        findings.unhandledExceptionCount++;
      }

      // DNS resolution failure — can't reach server by hostname
      const dnsMatch = RE_DNS_FAILURE.exec(msg);
      if (dnsMatch) {
        const host = dnsMatch[1];
        findings.dnsFailures.set(host, (findings.dnsFailures.get(host) ?? 0) + 1);
      }

      // Session/token failure — expired or invalid session
      if (RE_SESSION_FAILURE.test(msg)) {
        findings.sessionFailureCount++;
      }

      // Request delivery failure — broader connectivity issue
      if (RE_DELIVERY_FAILURE.test(msg)) {
        findings.deliveryFailureCount++;
      }
    }
  }

  findings.aliveTargets = [...aliveTargetSet].sort();

  // Compute DeltaCache polling gaps using adaptive threshold (2× median interval, min 10 min)
  if (deltaCacheTimes.length >= 2) {
    deltaCacheTimes.sort((a, b) => a - b);

    // Calculate median interval to set adaptive threshold
    const intervals: number[] = [];
    for (let i = 1; i < deltaCacheTimes.length; i++) {
      intervals.push(deltaCacheTimes[i] - deltaCacheTimes[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const medianMs = intervals[Math.floor(intervals.length / 2)];
    const thresholdMs = Math.max(medianMs * 2, 600_000); // 2× median, min 10 min

    for (let i = 1; i < deltaCacheTimes.length; i++) {
      const gapMs = deltaCacheTimes[i] - deltaCacheTimes[i - 1];
      if (gapMs > thresholdMs) {
        const toTs = (ms: number) => {
          const h = Math.floor(ms / 3_600_000);
          const m = Math.floor((ms % 3_600_000) / 60_000);
          const s = Math.floor((ms % 60_000) / 1_000);
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        };
        findings.deltaCacheGaps.push({
          from: toTs(deltaCacheTimes[i - 1]),
          to: toTs(deltaCacheTimes[i]),
          gapMins: Math.round((gapMs / 60_000) * 10) / 10,
        });
      }
    }
  }

  return findings;
}

const SEVERITY_ICON: Record<Severity, string> = {
  CRITICAL: "🔴",
  WARNING: "🟡",
  INFO: "🟢",
};

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function toolTriage(
  logDir: string | string[],
  bugReport: BugReport | null,
  args: {
    sccpFiles?: string[];
    errorFiles?: string[];
    lifecycleFiles?: string[];
    startTime?: string;
    endTime?: string;
  }
): Promise<string> {
  let { sccpFiles, errorFiles, lifecycleFiles, startTime, endTime } = args;

  // ── Auto-discover files if not provided ──────────────────────────────────
  if (!sccpFiles) {
    const found = await listLogFiles(logDir, { prefix: "sccp" });
    sccpFiles = found.length > 0 ? ["sccp"] : [];
  }
  if (!errorFiles) {
    const found = await listLogFiles(logDir, { prefix: "is" });
    errorFiles = found.length > 0 ? ["is"] : [];
  }
  if (!lifecycleFiles) {
    const found = await listLogFiles(logDir, { prefix: "is" });
    lifecycleFiles = found.length > 0 ? ["is"] : [];
  }

  // ── Run analyses in parallel ─────────────────────────────────────────────
  const promises: [
    Promise<Awaited<ReturnType<typeof computeHealthSummary>>>,
    Promise<Awaited<ReturnType<typeof computeErrorGroups>>>,
    Promise<string>,
    Promise<string | null>,
    Promise<ConnectivityFindings>,
  ] = [
    sccpFiles.length > 0
      ? computeHealthSummary(logDir, { sccpFiles, errorFiles, startTime, endTime })
      : Promise.reject(new Error("No sccp files available")),

    errorFiles.length > 0
      ? computeErrorGroups(logDir, { files: errorFiles, deduplicate: true, startTime, endTime })
      : Promise.reject(new Error("No error files available")),

    lifecycleFiles.length > 0
      ? toolGetServiceLifecycle(logDir, { files: lifecycleFiles, startTime, endTime, limit: 50 })
      : Promise.reject(new Error("No lifecycle files available")),

    bugReport != null
      ? toolEventLog(bugReport, { log: "both", mode: "summary" })
      : Promise.resolve(null),

    scanConnectivity(logDir, startTime, endTime),
  ];

  const [healthResult, errorResult, lifecycleResult, eventLogResult, connectivityResult] =
    await Promise.allSettled(promises);

  // ── Build findings ───────────────────────────────────────────────────────
  const findings: Finding[] = [];

  // --- Health findings ---
  if (healthResult.status === "fulfilled") {
    const h = healthResult.value;

    if (h.crashLoopCount > 0) {
      const crashNames = h.processRows
        .filter(r => r.pattern === "crash-loop")
        .map(r => r.name);
      const names = summarizeProcessNames(crashNames);
      findings.push({
        severity: "CRITICAL",
        category: "Health",
        message: `${h.crashLoopCount} process(es) in crash-loop: ${names}`,
        drillDown: "sym_lifecycle mode=processes",
      });
    }

    if (h.totalRestarts > 0) {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: `${h.totalRestarts} total restart(s) detected`,
        drillDown: "sym_health",
      });
    }

    const degrading = h.processRows.filter(r => r.pattern === "degrading").map(r => r.name);
    if (degrading.length > 0) {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: `Memory degradation in: ${degrading.join(", ")}`,
        drillDown: "sym_health mode=trends",
      });
    }

    // Overall health rating
    let health: string;
    if (h.crashLoopCount > 0 || h.totalRestarts >= 5) {
      health = "CRITICAL";
    } else if (h.totalRestarts > 0 || h.errorCount > 50) {
      health = "DEGRADED";
    } else {
      health = "HEALTHY";
    }

    if (health === "CRITICAL") {
      findings.push({
        severity: "CRITICAL",
        category: "Health",
        message: "Overall health: CRITICAL",
        drillDown: "sym_health",
      });
    } else if (health === "DEGRADED") {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: "Overall health: DEGRADED",
        drillDown: "sym_health",
      });
    } else if (
      health === "HEALTHY" &&
      findings.length === 0
    ) {
      findings.push({
        severity: "INFO",
        category: "Health",
        message: "System appears healthy",
        drillDown: "sym_health",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Health",
      message: `Could not run health analysis: ${healthResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_health",
    });
  }

  // --- Error findings ---
  if (errorResult.status === "fulfilled") {
    const groups = errorResult.value.groups;
    const errorCount = [...groups.values()].reduce((s, g) => s + g.count, 0);
    const uniquePatterns = groups.size;

    if (errorCount > 50) {
      findings.push({
        severity: "WARNING",
        category: "Errors",
        message: `${errorCount} errors (${uniquePatterns} unique patterns)`,
        drillDown: "sym_search mode=errors files=is",
      });
    } else if (errorCount > 0) {
      findings.push({
        severity: "INFO",
        category: "Errors",
        message: `${errorCount} errors (${uniquePatterns} unique patterns)`,
        drillDown: "sym_search mode=errors files=is",
      });
    }

    // Top 3 error messages
    const topErrors = [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    for (const e of topErrors) {
      findings.push({
        severity: "INFO",
        category: "Errors",
        message: `Top error: "${e.first.line.message.slice(0, 80)}"  (×${e.count})`,
        drillDown: "sym_search mode=errors files=is",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Errors",
      message: `Could not run error analysis: ${errorResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_search mode=errors",
    });
  }

  // --- Lifecycle findings ---
  if (lifecycleResult.status === "fulfilled") {
    const lcText = lifecycleResult.value;
    if (lcText.includes("CAUSE")) {
      const preview = lcText.split("\n").find(l => l.includes("CAUSE"))?.trim() ?? "";
      findings.push({
        severity: "WARNING",
        category: "Lifecycle",
        message: preview.slice(0, 120),
        drillDown: "sym_lifecycle mode=services",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Lifecycle",
      message: `Could not run lifecycle analysis: ${lifecycleResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_lifecycle",
    });
  }

  // --- Event log findings ---
  if (eventLogResult.status === "fulfilled") {
    const elText = eventLogResult.value;
    if (elText != null && (/Error/i.test(elText) || /Critical/i.test(elText))) {
      findings.push({
        severity: "WARNING",
        category: "Event Log",
        message: "Windows Event Log contains Error/Critical entries",
        drillDown: "sym_event_log",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Event Log",
      message: `Could not run event log analysis: ${eventLogResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_event_log",
    });
  }

  // --- Connectivity findings (inter-server) ---
  if (connectivityResult.status === "fulfilled") {
    const conn = connectivityResult.value;

    // SEEMS FAILED — this server thinks other servers are down
    if (conn.seemsFailedServers.length > 0) {
      findings.push({
        severity: "CRITICAL",
        category: "Connectivity",
        message: `Server reports ${conn.seemsFailedServers.length} peer(s) SEEMS FAILED: ${conn.seemsFailedServers.join(", ")}`,
        drillDown: "sym_interserver mode=summary",
      });
    }

    // One-way communication: sends ALIVE but receives none
    if (conn.isFarmMember && conn.aliveSendCount > 0 && conn.aliveRecvCount === 0) {
      findings.push({
        severity: "CRITICAL",
        category: "Connectivity",
        message: `ISOLATED — one-way communication: ${conn.aliveSendCount} ALIVE sent → ${conn.aliveTargets.join(", ")} but 0 received — possible firewall blocking inbound`,
        drillDown: "sym_interserver mode=map",
      });
    } else if (conn.isFarmMember && conn.aliveSendCount > 0 && conn.aliveRecvCount > 0) {
      // Healthy ALIVE exchange — just note it
      findings.push({
        severity: "INFO",
        category: "Connectivity",
        message: `ALIVE: ${conn.aliveSendCount} sent, ${conn.aliveRecvCount} received — farm peers: ${conn.aliveTargets.join(", ")}`,
        drillDown: "sym_interserver mode=map",
      });
    }

    // ForceServerRefreshDeviceGraph missing
    if (conn.isFarmMember && !conn.hasForceRefresh) {
      findings.push({
        severity: "WARNING",
        category: "Connectivity",
        message: "No ForceServerRefreshDeviceGraph received — server may not get push notifications for device changes",
        drillDown: "sym_interserver mode=summary",
      });
    }

    // DeltaCache polling gaps
    if (conn.deltaCacheGaps.length > 0) {
      const worst = conn.deltaCacheGaps.reduce((max, g) => g.gapMins > max.gapMins ? g : max);
      findings.push({
        severity: "WARNING",
        category: "Connectivity",
        message: `UpdateDeltaCache polling gap: ${worst.gapMins} min (${worst.from} → ${worst.to}) — ${conn.deltaCacheGaps.length} gap(s) exceeding threshold`,
        drillDown: "sym_interserver mode=summary",
      });
    }

    // DownServer RPC — servers reported as down by peers
    if (conn.downServerReports.size > 0) {
      const sorted = [...conn.downServerReports.entries()].sort((a, b) => b[1] - a[1]);
      const topDown = sorted.slice(0, 5).map(([id, n]) => `${id} (×${n})`).join(", ");
      const totalReports = sorted.reduce((s, [, n]) => s + n, 0);
      findings.push({
        severity: sorted[0][1] > 10 ? "WARNING" : "INFO",
        category: "Connectivity",
        message: `DownServer RPC: ${totalReports} report(s) for ${conn.downServerReports.size} server(s): ${topDown}`,
        drillDown: "sym_interserver mode=failures",
      });
    }

    // Master changeover — critical farm event
    if (conn.masterChanges.length > 0) {
      for (const mc of conn.masterChanges) {
        findings.push({
          severity: "CRITICAL",
          category: "Connectivity",
          message: `MASTER CHANGEOVER at ${mc.timestamp}: ${mc.from} → ${mc.to}`,
          drillDown: "sym_timeline",
        });
      }
    }

    // BACK UP recovery events — pair with SEEMS FAILED for context
    if (conn.backUpServers.length > 0) {
      findings.push({
        severity: "INFO",
        category: "Connectivity",
        message: `Server(s) recovered (BACK UP): ${conn.backUpServers.join(", ")}`,
        drillDown: "sym_interserver mode=summary",
      });
    }

    // SSL certificate issues
    if (conn.sslIssues.size > 0) {
      const totalSsl = [...conn.sslIssues.values()].reduce((s, n) => s + n, 0);
      const types = [...conn.sslIssues.entries()].map(([t, n]) => `${t} (×${n})`).join(", ");
      const severity: Severity = conn.sslIssues.has("RemoteCertificateChainErrors") || conn.sslIssues.has("RemoteCertificateNameMismatch")
        ? "WARNING" : "INFO";
      findings.push({
        severity,
        category: "Connectivity",
        message: `SSL certificate issues: ${totalSsl} event(s) — ${types}`,
        drillDown: "sym_search pattern='SSL policy'",
      });
    }

    // No message dispatcher — message routing overload
    if (conn.noDispatcherCount > 0) {
      findings.push({
        severity: conn.noDispatcherCount > 10 ? "WARNING" : "INFO",
        category: "Connectivity",
        message: `Message routing overload: ${conn.noDispatcherCount} "No message dispatcher" event(s)`,
        drillDown: "sym_search pattern='No message dispatcher'",
      });
    }

    // Service stop request — restart cause classification
    if (conn.serviceStopRequests.size > 0) {
      const services = [...conn.serviceStopRequests.entries()].map(([svc, n]) => `${svc} (×${n})`).join(", ");
      findings.push({
        severity: "WARNING",
        category: "Lifecycle",
        message: `Service stop requested: ${services} — indicates graceful restart (not crash)`,
        drillDown: "sym_lifecycle",
      });
    }

    // PendingChanges timeout — camera API blocking
    if (conn.pendingChangesTimeouts.length > 0) {
      findings.push({
        severity: "WARNING",
        category: "Errors",
        message: `${conn.pendingChangesTimeouts.length} PendingChanges timeout(s) — camera API blocked for ${conn.pendingChangesTimeouts[0]}`,
        drillDown: "sym_http",
      });
    }

    // Address config errors — server with blank/missing address
    if (conn.addressErrors.size > 0) {
      const servers = [...conn.addressErrors.entries()].map(([id, n]) => `${id} (×${n})`).join(", ");
      findings.push({
        severity: "WARNING",
        category: "Configuration",
        message: `Server(s) with missing address config: ${servers}`,
        drillDown: "sym_search pattern='Error getting address'",
      });
    }

    // Crash dumps — process crashed hard enough to save minidump
    if (conn.crashDumps.length > 0) {
      findings.push({
        severity: "CRITICAL",
        category: "Crashes",
        message: `${conn.crashDumps.length} crash dump(s) saved — process crash detected`,
        drillDown: "sym_search pattern='Saved minidump'",
      });
    }

    // Unhandled exceptions — process about to crash or crashing
    if (conn.unhandledExceptionCount > 0) {
      findings.push({
        severity: "CRITICAL",
        category: "Crashes",
        message: `${conn.unhandledExceptionCount} unhandled exception event(s) — application crash(es)`,
        drillDown: "sym_search pattern='UnhandledException'",
      });
    }

    // DNS resolution failures
    if (conn.dnsFailures.size > 0) {
      const hosts = [...conn.dnsFailures.entries()].map(([h, n]) => `${h} (×${n})`).join(", ");
      findings.push({
        severity: "WARNING",
        category: "Connectivity",
        message: `DNS resolution failures: ${hosts}`,
        drillDown: "sym_search pattern='Unable to resolve server address'",
      });
    }

    // Session/token failures
    if (conn.sessionFailureCount > 20) {
      findings.push({
        severity: "WARNING",
        category: "Security",
        message: `${conn.sessionFailureCount} session/token failure(s) — possible session expiry or auth issues`,
        drillDown: "sym_search pattern='TokenNotFoundException'",
      });
    } else if (conn.sessionFailureCount > 0) {
      findings.push({
        severity: "INFO",
        category: "Security",
        message: `${conn.sessionFailureCount} session/token failure(s)`,
        drillDown: "sym_search pattern='TokenNotFoundException'",
      });
    }

    // Request delivery failures (broader than No message dispatcher)
    if (conn.deliveryFailureCount > 10) {
      findings.push({
        severity: "WARNING",
        category: "Connectivity",
        message: `${conn.deliveryFailureCount} request delivery failure(s) — server communication disrupted`,
        drillDown: "sym_search pattern='RequestFailedDelivery'",
      });
    } else if (conn.deliveryFailureCount > 0) {
      findings.push({
        severity: "INFO",
        category: "Connectivity",
        message: `${conn.deliveryFailureCount} request delivery failure(s)`,
        drillDown: "sym_search pattern='RequestFailedDelivery'",
      });
    }

    // Log level quality — warn if logs lack diagnostic detail
    const isLevel = conn.isLogLevel;
    const aeLevel = conn.aeLogLevel;

    if (isLevel && !isLevel.hasDiagnostic) {
      findings.push({
        severity: "WARNING",
        category: "Log Quality",
        message: `Server (IS) log level is minimal: ${isLevel.levels} — missing diagnostic data, increase to include MoreInfo + LogDiagnostic`,
        drillDown: "sym_search pattern='Logging level changed'",
      });
    } else if (!isLevel && conn.observedLevels.size > 0) {
      // Heuristic: if we have IS entries but no explicit level message, check distribution
      const hasDiag = (conn.observedLevels.get("Diagnostic") ?? 0) > 0;
      const hasMore = (conn.observedLevels.get("MoreInfo") ?? 0) > 0;
      if (!hasDiag && !hasMore) {
        findings.push({
          severity: "WARNING",
          category: "Log Quality",
          message: "Server (IS) logs contain only BasicInfo+Error entries — likely minimal log level, missing diagnostic data",
          drillDown: "sym_search pattern='Logging level changed'",
        });
      }
    }
    if (isLevel?.hasDiagnostic) {
      findings.push({
        severity: "INFO",
        category: "Log Quality",
        message: `Server (IS) log level: ${isLevel.levels}`,
        drillDown: "sym_search pattern='Logging level changed'",
      });
    }

    if (aeLevel && !aeLevel.hasDiagnostic) {
      findings.push({
        severity: "WARNING",
        category: "Log Quality",
        message: `Client (AE) log level is minimal: ${aeLevel.levels} — missing diagnostic data`,
        drillDown: "sym_search pattern='Logging level changed'",
      });
    } else if (aeLevel?.hasDiagnostic) {
      findings.push({
        severity: "INFO",
        category: "Log Quality",
        message: `Client (AE) log level: ${aeLevel.levels}`,
        drillDown: "sym_search pattern='Logging level changed'",
      });
    }

    // Per-service log levels summary
    if (conn.serverLogLevels.size > 0) {
      const minimal = [...conn.serverLogLevels.entries()]
        .filter(([, info]) => !info.hasDiagnostic)
        .map(([svc]) => svc);
      if (minimal.length > 0) {
        findings.push({
          severity: "WARNING",
          category: "Log Quality",
          message: `Service(s) at minimal log level: ${minimal.join(", ")}`,
          drillDown: "sym_search pattern='UpdateServerLogLevel'",
        });
      }
    }

    // Upgrade health rating if one-way communication detected
    if (conn.isFarmMember && conn.aliveSendCount > 0 && conn.aliveRecvCount === 0) {
      // Override any existing HEALTHY rating — this server is isolated
      const existingHealthy = findings.find(
        f => f.category === "Health" && f.message.includes("HEALTHY")
      );
      if (existingHealthy) {
        existingHealthy.severity = "WARNING";
        existingHealthy.message = "Process health: HEALTHY — but server is ISOLATED from farm (see Connectivity)";
      }
    }
  }

  // ── Sort: CRITICAL > WARNING > INFO ──────────────────────────────────────
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // ── Format output ────────────────────────────────────────────────────────
  const critical = findings.filter(f => f.severity === "CRITICAL").length;
  const warnings = findings.filter(f => f.severity === "WARNING").length;
  const info = findings.filter(f => f.severity === "INFO").length;

  const bar = "═".repeat(47);
  const out: string[] = [
    bar,
    "  SYMPHONY TRIAGE REPORT",
    bar,
    "",
    `  ${findings.length} finding(s) — ${critical} critical, ${warnings} warnings, ${info} info`,
    "",
  ];

  for (const f of findings) {
    const icon = SEVERITY_ICON[f.severity];
    const sev = f.severity.padEnd(8);
    out.push(`  ${icon} ${sev}  [${f.category}] ${f.message}`);
    out.push(`     → Drill down: ${f.drillDown}`);
    out.push("");
  }

  out.push(bar);

  return out.join("\n");
}
