/**
 * db-health.ts
 *
 * Analyse database connectivity and health from Symphony IS logs:
 *   - DB connection failures / outage detection
 *   - Connection pool state
 *   - SQL exceptions
 *   - DbConnectionFailedException bursts → outage windows
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, listLogFiles, appendWarnings } from "../lib/log-reader.js";
import { timestampToMs } from "../lib/log-parser.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_DB_CONN_FAIL  = /DbConnectionFailedException|Error establishing connection|DB is down|database.*(?:unavailable|unreachable)/i;
const RE_SQL_EXCEPTION = /SqlException|SQL\s+Server|MSSQL|deadlock/i;
const RE_CONN_POOL     = /connection\s*pool|pool\s+(?:exhausted|full|limit)/i;
const RE_DB_TIMEOUT    = /(?:database|db|sql).*timeout|command\s+timeout/i;
const RE_DB_RECOVERED  = /(?:database|db)\s+(?:connection\s+)?(?:restored|recovered|reconnected|established)/i;
const RE_DB_NAME       = /(?:database|connecting to the)\s+['"]?(\w+)['"]?\s+(?:database\s+)?(?:on|at)\s+(?:the\s+)?(?:server\s+)?['"]?([^'".\s]+)/i;

interface DbEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "connection_failure" | "sql_error" | "pool_issue" | "timeout" | "recovery";
  database: string;
  server: string;
  message: string;
  source: string;
  file: string;
}

interface OutageWindow {
  start: string;
  end: string;
  durationMs: number;
  eventCount: number;
  database: string;
  server: string;
}

export interface DbHealthArgs {
  mode: "summary" | "outages" | "events";
  files?: string[];
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export async function toolDbHealth(
  logDir: string | string[],
  args: DbHealthArgs,
): Promise<string> {
  const { mode, limit = 50, startTime, endTime } = args;

  let files = args.files;
  if (!files || files.length === 0) files = ["is"];
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return "No log files found. Try specifying files (e.g., 'is').";

  const events: DbEvent[] = [];
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, startTime, endTime)) continue;
      const msg = entry.line.message;
      const fullMsg = entry.fullText;

      let category: DbEvent["category"] | null = null;
      if (RE_DB_RECOVERED.test(msg))      category = "recovery";
      else if (RE_DB_CONN_FAIL.test(msg)) category = "connection_failure";
      else if (RE_CONN_POOL.test(msg))    category = "pool_issue";
      else if (RE_DB_TIMEOUT.test(msg))   category = "timeout";
      else if (RE_SQL_EXCEPTION.test(msg)) category = "sql_error";

      if (!category) continue;

      // Extract database name and server
      let database = "";
      let server = "";
      const dbMatch = RE_DB_NAME.exec(fullMsg);
      if (dbMatch) {
        database = dbMatch[1] ?? "";
        server = dbMatch[2] ?? "";
      }

      events.push({
        timestamp: entry.line.timestamp,
        timestampMs: entry.line.timestampMs,
        level: entry.line.level,
        category,
        database,
        server,
        message: msg.slice(0, 200),
        source: entry.line.source,
        file: fileRef,
      });
    }
  }

  if (events.length === 0) return appendWarnings("No database health events found.", warnings);

  switch (mode) {
    case "summary":
      return appendWarnings(formatDbSummary(events), warnings);
    case "outages":
      return appendWarnings(formatOutages(events), warnings);
    case "events":
      return appendWarnings(formatDbEvents(events, limit), warnings);
    default:
      return `Unknown mode '${mode}'. Use: summary, outages, events`;
  }
}

function detectOutages(events: DbEvent[]): OutageWindow[] {
  const failures = events.filter(e => e.category === "connection_failure" || e.category === "timeout");
  if (failures.length === 0) return [];

  // Cluster failures within 60s of each other into outage windows
  const GAP_MS = 60_000;
  const windows: OutageWindow[] = [];
  let windowStart = failures[0];
  let windowEnd = failures[0];
  let count = 1;

  for (let i = 1; i < failures.length; i++) {
    if (failures[i].timestampMs - windowEnd.timestampMs <= GAP_MS) {
      windowEnd = failures[i];
      count++;
    } else {
      if (count >= 3) {
        windows.push({
          start: windowStart.timestamp,
          end: windowEnd.timestamp,
          durationMs: windowEnd.timestampMs - windowStart.timestampMs,
          eventCount: count,
          database: windowStart.database || "(unknown)",
          server: windowStart.server || "(unknown)",
        });
      }
      windowStart = failures[i];
      windowEnd = failures[i];
      count = 1;
    }
  }
  // Final window
  if (count >= 3) {
    windows.push({
      start: windowStart.timestamp,
      end: windowEnd.timestamp,
      durationMs: windowEnd.timestampMs - windowStart.timestampMs,
      eventCount: count,
      database: windowStart.database || "(unknown)",
      server: windowStart.server || "(unknown)",
    });
  }

  return windows;
}

function formatDbSummary(events: DbEvent[]): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  DATABASE HEALTH SUMMARY");
  out.push("═".repeat(60));
  out.push("");

  // By category
  const byCat = new Map<string, number>();
  for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
  out.push("Event Types:");
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(count).padStart(6)}×  ${cat.replace(/_/g, " ")}`);
  }
  out.push("");

  // By database
  const byDb = new Map<string, number>();
  for (const e of events) {
    const key = e.database && e.server ? `${e.database}@${e.server}` : e.database || e.server || "(unknown)";
    byDb.set(key, (byDb.get(key) ?? 0) + 1);
  }
  if (byDb.size > 0) {
    out.push("By Database:");
    for (const [db, count] of [...byDb.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(6)}×  ${db}`);
    }
    out.push("");
  }

  // Outage detection
  const outages = detectOutages(events);
  if (outages.length > 0) {
    out.push(`⚠ DETECTED ${outages.length} OUTAGE WINDOW(S):`);
    for (const o of outages) {
      const durSec = Math.round(o.durationMs / 1000);
      out.push(`  ${o.start} → ${o.end} (${durSec}s, ${o.eventCount} events) DB: ${o.database}@${o.server}`);
    }
  } else {
    out.push("No outage windows detected (isolated errors only).");
  }

  out.push("");
  out.push(`Total events: ${events.length}  |  Time range: ${events[0].timestamp} → ${events[events.length - 1].timestamp}`);
  out.push("═".repeat(60));
  return out.join("\n");
}

function formatOutages(events: DbEvent[]): string {
  const outages = detectOutages(events);
  if (outages.length === 0) return "No outage windows detected. Use mode=events to see individual DB errors.";

  const out: string[] = [];
  out.push(`Detected ${outages.length} outage window(s):`);
  out.push("");

  for (const o of outages) {
    const durSec = Math.round(o.durationMs / 1000);
    const durMin = (o.durationMs / 60_000).toFixed(1);
    out.push(`  ⚠ ${o.start} → ${o.end}`);
    out.push(`    Duration: ${durSec}s (${durMin} min)  |  Events: ${o.eventCount}`);
    out.push(`    Database: ${o.database}  Server: ${o.server}`);
    out.push("");
  }

  return out.join("\n");
}

function formatDbEvents(events: DbEvent[], limit: number): string {
  const out: string[] = [];
  out.push(`Found ${events.length} database event(s) (showing ${Math.min(events.length, limit)}):`);
  out.push("");

  const shown = events.slice(0, limit);
  for (const e of shown) {
    const icon = e.category === "recovery" ? "✓" : "✗";
    out.push(`  ${icon} [${e.timestamp}] ${e.category.padEnd(20)} ${e.message.slice(0, 100)}`);
  }

  return out.join("\n");
}
