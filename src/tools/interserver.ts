/**
 * interserver.ts
 *
 * Analyse inter-server communication patterns from Symphony IS logs:
 *   - ALIVE/PING messages between servers
 *   - ConnectionException / ExecuteOnProxy failures
 *   - ClientTerminated events
 *   - Build a server communication map
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, listLogFiles, appendWarnings } from "../lib/log-reader.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_ALIVE_SEND  = /(?:Sending|Sent)\s+ALIVE\s*(?:---?>|→)\s*([\d,\s]+)/i;
const RE_ALIVE_RECV  = /Received\s+ALIVE\s*(?:<---|←)\s*(\d+)/i;
const RE_PING_SEND   = /SendMessageToBuddies.*(?:ALIVE|PING)\s+message\s+to\s+([\d.]+(?::\d+)?)/i;
const RE_EXEC_PROXY  = /ExecuteOnProxy\s+failed\s+for\s+(\d+)/i;
const RE_CONN_EXCEPT = /(?:HandleConnectionEstablished|Unable to connect to)\s+(?:server\s+)?(\d+|[\d.]+(?::\d+)?)/i;
const RE_CLIENT_TERM = /ClientTerminated.*Processing of client\s+([\d.]+(?::\d+)?)/i;
const RE_SERVER_ID   = /(?:server\s*|--+\s*>?\s*)(\d{4,5})/i;
const RE_IP_EXTRACT  = /([\d.]+(?::\d+)?)/;
const RE_IP_TO_SERVER = /(?:server|Server)\s+(\d{4,5}).*?([\d]+\.[\d]+\.[\d]+\.[\d]+)/i;
const RE_SERVER_IP_REVERSE = /([\d]+\.[\d]+\.[\d]+\.[\d]+).*?(?:server|Server)\s+(\d{4,5})/i;

interface InterServerEvent {
  timestamp: string;
  category: "alive_send" | "alive_recv" | "proxy_fail" | "conn_fail" | "client_term";
  targets: string[];
  message: string;
  file: string;
}

export interface InterServerArgs {
  mode: "map" | "failures" | "summary";
  files?: string[];
  serverFilter?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export async function toolInterServer(
  logDir: string | string[],
  args: InterServerArgs,
): Promise<string> {
  const { mode, limit = 50, serverFilter, startTime, endTime } = args;

  let files = args.files;
  if (!files || files.length === 0) files = ["is"];
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return "No log files found. Try specifying files (e.g., 'is').";

  const events: InterServerEvent[] = [];
  const ipToServer = new Map<string, string>();
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, startTime, endTime)) continue;
      const msg = entry.line.message;

      // Build IP-to-server-ID mapping from log mentions
      const ipSrv = RE_IP_TO_SERVER.exec(msg);
      if (ipSrv) {
        const ip = ipSrv[2].replace(/:\d+$/, "");
        ipToServer.set(ip, ipSrv[1]);
      }
      const ipSrvRev = RE_SERVER_IP_REVERSE.exec(msg);
      if (ipSrvRev) {
        const ip = ipSrvRev[1].replace(/:\d+$/, "");
        ipToServer.set(ip, ipSrvRev[2]);
      }

      let category: InterServerEvent["category"] | null = null;
      let targets: string[] = [];

      // ALIVE sent → list of server IDs
      const aliveSend = RE_ALIVE_SEND.exec(msg);
      if (aliveSend) {
        category = "alive_send";
        targets = aliveSend[1].split(/[,\s]+/).filter(s => /^\d+$/.test(s.trim())).map(s => s.trim());
      }

      // ALIVE received ← server ID
      if (!category) {
        const aliveRecv = RE_ALIVE_RECV.exec(msg);
        if (aliveRecv) {
          category = "alive_recv";
          targets = [aliveRecv[1].trim()];
        }
      }

      // PING to IP:port
      if (!category) {
        const ping = RE_PING_SEND.exec(msg);
        if (ping) {
          category = "alive_send";
          targets = [ping[1].trim()];
        }
      }

      // ExecuteOnProxy failure
      if (!category) {
        const proxy = RE_EXEC_PROXY.exec(msg);
        if (proxy) {
          category = "proxy_fail";
          targets = [proxy[1].trim()];
        }
      }

      // Connection exception
      if (!category) {
        const conn = RE_CONN_EXCEPT.exec(msg);
        if (conn) {
          category = "conn_fail";
          targets = [conn[1].trim()];
        }
      }

      // Client terminated
      if (!category) {
        const term = RE_CLIENT_TERM.exec(msg);
        if (term) {
          category = "client_term";
          targets = [term[1].trim()];
        }
      }

      if (!category) continue;

      if (serverFilter) {
        const matches = targets.some(t => t.includes(serverFilter));
        if (!matches) continue;
      }

      events.push({
        timestamp: entry.line.timestamp,
        category,
        targets,
        message: msg.slice(0, 200),
        file: fileRef,
      });
    }
  }

  if (events.length === 0) {
    return appendWarnings("No inter-server communication events found" +
      (serverFilter ? ` matching '${serverFilter}'` : "") + ".", warnings);
  }

  switch (mode) {
    case "summary":
      return appendWarnings(formatSummary(events, ipToServer), warnings);
    case "map":
      return appendWarnings(formatMap(events, ipToServer), warnings);
    case "failures":
      return appendWarnings(formatFailures(events, limit, ipToServer), warnings);
    default:
      return `Unknown mode '${mode}'. Use: summary, map, failures`;
  }
}

function resolveTarget(target: string, ipToServer: Map<string, string>): string {
  const ip = target.replace(/:\d+$/, "");
  const serverId = ipToServer.get(ip);
  return serverId ? `${target} (server ${serverId})` : target;
}

function formatSummary(events: InterServerEvent[], ipToServer: Map<string, string>): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  INTER-SERVER COMMUNICATION SUMMARY");
  out.push("═".repeat(60));
  out.push("");

  const byCat = new Map<string, number>();
  for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

  out.push("Event Types:");
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    const label = cat.replace(/_/g, " ");
    out.push(`  ${String(count).padStart(6)}×  ${label}`);
  }
  out.push("");

  // Asymmetry detection
  const aliveSendCount = byCat.get("alive_send") ?? 0;
  const aliveRecvCount = byCat.get("alive_recv") ?? 0;

  if (aliveSendCount > 0 && aliveRecvCount === 0) {
    out.push("⚠️  ASYMMETRY ALERT: Sends ALIVE but receives NONE");
    out.push("    This server is likely ISOLATED — inbound traffic may be blocked.");
    out.push("    Possible causes: firewall rule, network partition, wrong port.");
    out.push("");
  } else if (aliveSendCount > 0 && aliveRecvCount > 0) {
    const ratio = aliveSendCount / aliveRecvCount;
    if (ratio > 5) {
      out.push(`⚠️  ASYMMETRY WARNING: Send/receive ratio is ${ratio.toFixed(1)}:1 (${aliveSendCount} sent / ${aliveRecvCount} received)`);
      out.push("    Some peers may not be responding. Check per-server breakdown.");
      out.push("");
    }
  }

  // Failures by target
  const failTargets = new Map<string, number>();
  for (const e of events) {
    if (e.category === "proxy_fail" || e.category === "conn_fail" || e.category === "client_term") {
      for (const t of e.targets) {
        failTargets.set(t, (failTargets.get(t) ?? 0) + 1);
      }
    }
  }

  if (failTargets.size > 0) {
    out.push("Failure Targets (most problematic):");
    out.push("─".repeat(40));
    for (const [target, count] of [...failTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      out.push(`  ${String(count).padStart(6)}×  → ${resolveTarget(target, ipToServer)}`);
    }
    out.push("");
  }

  // IP-to-Server mapping
  if (ipToServer.size > 0) {
    out.push("Known IP → Server Mapping:");
    out.push("─".repeat(40));
    for (const [ip, sid] of [...ipToServer.entries()].sort()) {
      out.push(`  ${ip.padEnd(20)} → server ${sid}`);
    }
    out.push("");
  }

  // Communication partners
  const partners = new Set<string>();
  for (const e of events) {
    if (e.category === "alive_send" || e.category === "alive_recv") {
      for (const t of e.targets) partners.add(t);
    }
  }
  if (partners.size > 0) {
    out.push(`Communication Partners: ${[...partners].sort().join(", ")}`);
  }

  out.push("");
  out.push(`Total events: ${events.length}  |  Time: ${events[0].timestamp} → ${events[events.length - 1].timestamp}`);
  out.push("═".repeat(60));
  return out.join("\n");
}

function getBaseTarget(target: string): string {
  // Server IDs like "5001" stay as-is
  if (/^\d{4,5}$/.test(target)) return target;
  // Strip port from IP:port
  return target.replace(/:\d+$/, "");
}

/** Canonicalize target: if an IP maps to a known server ID, return the server ID. */
function canonicalTarget(target: string, ipToServer: Map<string, string>): string {
  const base = getBaseTarget(target);
  // If it's already a server ID, keep it
  if (/^\d{4,5}$/.test(base)) return base;
  // Check if this IP maps to a known server
  const serverId = ipToServer.get(base);
  return serverId ?? base;
}

function formatMap(events: InterServerEvent[], ipToServer: Map<string, string>): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  SERVER COMMUNICATION MAP");
  out.push("═".repeat(60));
  out.push("");

  // --- Aggregate by base IP (strip ephemeral ports) ---
  interface PeerStats {
    sent: number;
    recv: number;
    fail: number;
    uniqueFailPorts: Set<string>;
  }

  const peers = new Map<string, PeerStats>();

  for (const e of events) {
    for (const t of e.targets) {
      const base = canonicalTarget(t, ipToServer);
      let stats = peers.get(base);
      if (!stats) {
        stats = { sent: 0, recv: 0, fail: 0, uniqueFailPorts: new Set() };
        peers.set(base, stats);
      }

      switch (e.category) {
        case "alive_send":
          stats.sent += 1;
          break;
        case "alive_recv":
          stats.recv += 1;
          break;
        case "proxy_fail":
        case "conn_fail":
        case "client_term":
          stats.fail += 1;
          // Track unique ports only for IP:port targets (not plain server IDs)
          const rawBase = getBaseTarget(t);
          if (t !== rawBase) stats.uniqueFailPorts.add(t);
          break;
      }
    }
  }

  // Sort: servers first (numeric IDs), then IPs
  const sorted = [...peers.entries()].sort((a, b) => {
    const aNum = /^\d+$/.test(a[0]);
    const bNum = /^\d+$/.test(b[0]);
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return a[0].localeCompare(b[0], undefined, { numeric: true });
  });

  for (const [base, stats] of sorted) {
    const asymmetry = stats.sent > 0 && stats.recv === 0 ? " ⚠️ONE-WAY" : "";
    const icon = stats.fail > 10 ? "✗" : stats.fail > 0 ? "~" : stats.sent > 0 && stats.recv === 0 ? "⚠" : "✓";
    // For server IDs, look up their IP for display. For IPs, look up their server ID.
    let display = base;
    if (/^\d{4,5}$/.test(base)) {
      // Server ID — find its IP for context
      for (const [ip, sid] of ipToServer) {
        if (sid === base) { display = `${base} (${ip})`; break; }
      }
    } else {
      // IP — resolve to server ID
      display = resolveTarget(base, ipToServer);
    }
    const portNote = stats.uniqueFailPorts.size > 1
      ? `  (${stats.uniqueFailPorts.size} client ports)`
      : "";
    out.push(`  ${icon} ${display.padEnd(30)}  sent: ${String(stats.sent).padStart(5)}  recv: ${String(stats.recv).padStart(5)}  fail: ${String(stats.fail).padStart(4)}${asymmetry}${portNote}`);
  }

  out.push("");
  out.push(`Total peers: ${peers.size}  |  Events: ${events.length}`);
  out.push("═".repeat(60));
  return out.join("\n");
}

function formatFailures(events: InterServerEvent[], limit: number, ipToServer: Map<string, string>): string {
  const failures = events.filter(e =>
    e.category === "proxy_fail" || e.category === "conn_fail" || e.category === "client_term"
  );

  const out: string[] = [];
  out.push(`Found ${failures.length} inter-server failure(s) (showing ${Math.min(failures.length, limit)}):`);
  out.push("");

  const shown = failures.slice(0, limit);
  for (const e of shown) {
    const targets = e.targets.map(t => resolveTarget(t, ipToServer)).join(", ");
    out.push(`  [${e.timestamp}] ${e.category.padEnd(12)} → ${targets}  ${e.message.slice(0, 80)}`);
  }

  return out.join("\n");
}
