/**
 * search-http-requests.ts
 *
 * Parses "RequestLogger" entries from Seer.Web.Host (OWIN middleware on port base+14,
 * default 50014 HTTPS). Request IDs cycle mod 99999.
 * Source: Seer.Web.Host\Middleware\RequestLogger.cs
 *
 * Log format (interleaved lines per request):
 *   BasicInfo:  RequestLogger   | [#N] GET /api/videowalls
 *   Verbose:    RequestLogger   | [#N] Request from 10.234.100.111
 *   MoreInfo:   RequestLogger   | [#N] GET /api/videowalls, status: 200, duration: 5 ms
 *   Diagnost:   RequestLogger   | [#N] GET /api/videowalls, WaitingForActivation, processing: 679 ms...
 *   Diagnost:   RequestLogger   | [#N] GET /api/videowalls, request was cancelled
 *   LogError:   RequestLogger   | [#N] GET /api/videowalls, status: 500, duration: 42 ms  (on exception)
 */

import * as path from "path";
import { resolveFileRefs, readRawLines, isInTimeWindow } from "../lib/log-reader.js";
import { timestampToMs } from "../lib/log-parser.js";
import { findSlowRpcRequests, formatSlowRequests, type SlowRequest } from "./slow-requests.js";

// ── Regex patterns ─────────────────────────────────────────────────────────────

// BasicInfo start line: "[#N] METHOD /path"
const RE_START  = /RequestLogger\s+\|\s+\[#(\d+)\]\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s*$/;
// Verbose "Request from IP"
const RE_FROM   = /RequestLogger\s+\|\s+\[#(\d+)\]\s+Request from\s+(\S+)/;
// MoreInfo completion: "[#N] METHOD /path, status: 200, duration: 5 ms"
const RE_DONE   = /RequestLogger\s+\|\s+\[#(\d+)\]\s+\S+\s+\S+,\s+status:\s+(\d+),\s+duration:\s+(\d+)\s+ms/;
// Diagnost slow: "[#N] METHOD /path, <TaskStatus>, processing: 679 ms..."
// TaskStatus can be WaitingForActivation, Running, RanToCompletion, etc.
const RE_SLOW   = /RequestLogger\s+\|\s+\[#(\d+)\]\s+.*,\s+\w+,?\s*processing:\s+(\d+)\s+ms/;
// Timestamp
const RE_TS     = /^(\d{2}:\d{2}:\d{2}\.\d{3})/;

interface HttpRequest {
  seq: number;
  method: string;
  path: string;
  clientIp: string | null;
  startedAt: string;
  completedAt: string | null;
  status: number | null;
  durationMs: number | null;
  slowWarnings: number[]; // "processing: N ms" intermediate warnings
  sourceFile: string;
}

/** Returns the status class string ("2xx", "3xx", "4xx", "5xx", "???") for a numeric status code. */
function statusClassOf(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "???";
}

/**
 * Check whether a status code matches a statusFilter entry.
 * Entries can be numeric (exact match) or class strings:
 *   "2xx", "3xx", "4xx", "5xx", "error" (≥400), "success" (2xx/3xx)
 */
function matchesStatusFilter(status: number | null, filters: (number | string)[]): boolean {
  const s = status ?? 0;
  return filters.some(f => {
    if (typeof f === "number") return s === f;
    switch (String(f).toLowerCase()) {
      case "2xx":     return s >= 200 && s < 300;
      case "3xx":     return s >= 300 && s < 400;
      case "4xx":     return s >= 400 && s < 500;
      case "5xx":     return s >= 500 && s < 600;
      case "error":   return s >= 400;
      case "success": return s >= 200 && s < 400;
      default:        return s === parseInt(String(f));
    }
  });
}

async function parseHttpRequests(
  fullPath: string,
  startTime?: string,
  endTime?: string
): Promise<HttpRequest[]> {
  let lines: string[];
  try {
    lines = await readRawLines(fullPath);
  } catch { return []; }

  const filename = path.basename(fullPath);

  const pending = new Map<number, HttpRequest>();
  const completed: HttpRequest[] = [];

  for (const line of lines) {
    const tsMatch = RE_TS.exec(line);
    if (!tsMatch) continue;
    const ts = tsMatch[1];
    if (startTime && endTime && !isInTimeWindow(ts, startTime, endTime)) continue;
    if (!line.includes("RequestLogger")) continue;

    const startM = RE_START.exec(line);
    if (startM) {
      const seq = parseInt(startM[1]);
      pending.set(seq, {
        seq,
        method: startM[2],
        path: startM[3],
        clientIp: null,
        startedAt: ts,
        completedAt: null,
        status: null,
        durationMs: null,
        slowWarnings: [],
        sourceFile: filename,
      });
      continue;
    }

    const fromM = RE_FROM.exec(line);
    if (fromM) {
      const req = pending.get(parseInt(fromM[1]));
      if (req) req.clientIp = fromM[2];
      continue;
    }

    const doneM = RE_DONE.exec(line);
    if (doneM) {
      const seq = parseInt(doneM[1]);
      const req = pending.get(seq);
      if (req) {
        req.completedAt = ts;
        req.status = parseInt(doneM[2]);
        req.durationMs = parseInt(doneM[3]);
        completed.push(req);
        pending.delete(seq);
      }
      continue;
    }

    const slowM = RE_SLOW.exec(line);
    if (slowM) {
      const req = pending.get(parseInt(slowM[1]));
      if (req && slowM[2]) req.slowWarnings.push(parseInt(slowM[2]));
    }
  }

  // include in-flight
  for (const req of pending.values()) completed.push(req);
  return completed;
}

// ── Tool ───────────────────────────────────────────────────────────────────────

export interface SearchHttpArgs {
  files: string[];
  /** Tool mode: 'requests' (default list/group), 'slow' (RPC + HTTP slow), 'rates', 'totals' */
  mode?: "requests" | "slow" | "rates" | "totals";
  pathFilter?: string;     // substring or regex string for the URL path
  method?: string;         // GET, POST, etc.
  minDurationMs?: number;  // only show requests slower than this
  clientIp?: string;       // filter by client IP substring
  statusFilter?: (number | string)[];  // e.g. [500, 503] or ["5xx", "error", "4xx"]
  groupBy?: "path" | "client" | "status" | "statusClass";  // aggregate stats instead of listing
  sortBy?: "avg" | "max" | "count" | "errors" | "duration" | "time";  // sort order
  rateBy?: "minute" | "5min" | "hour";           // show rate-over-time histogram instead of groupBy/list
  /** For slow mode: also include RPC-level "took HH:MM:SS" entries (default true) */
  includeRpc?: boolean;
  /** For slow mode: group by method name */
  slowGroupBy?: "request";
  /** Minimum duration threshold in ms for slow mode (default 1000) */
  thresholdMs?: number;
  /**
   * Analyse request rate per minute to automatically identify the peak-traffic
   * test window (continuous period where rate ≥ 10% of peak minute rate).
   */
  detectActiveWindow?: boolean;
  startTime?: string;
  endTime?: string;
  limit?: number;
  isAssets?: boolean;      // include /assets/ and /bundles/ static file requests (default false)
  /** Return just a status-class summary table (2xx/3xx/4xx/5xx + error rate) without the full listing. */
  totalsOnly?: boolean;
}

export async function toolSearchHttpRequests(
  logDir: string | string[],
  args: SearchHttpArgs
): Promise<string> {
  const {
    pathFilter,
    method,
    minDurationMs,
    clientIp,
    statusFilter,
    groupBy,
    sortBy,
    rateBy,
    detectActiveWindow,
    startTime,
    endTime,
    limit = 100,
    isAssets = false,
    totalsOnly = false,
  } = args;

  const toolMode = args.mode ?? "requests";

  // ── "slow" mode: merged RPC + HTTP slow request analysis ────────────────
  if (toolMode === "slow") {
    const thresholdMs = args.thresholdMs ?? 1000;
    const includeRpc = args.includeRpc !== false;
    const slowLimit = args.limit ?? 50;
    const slowSortBy = (args.sortBy as "duration" | "time") ?? "duration";

    const allSlow: SlowRequest[] = [];

    // HTTP-layer slow requests
    const paths = await resolveFileRefs(args.files, logDir);
    for (const fp of paths) {
      const entries = await findSlowHttpRequests(fp, thresholdMs, startTime, endTime);
      for (const e of entries) {
        allSlow.push({
          file: e.file,
          timestamp: e.timestamp,
          threadId: "-",
          source: "RequestLogger (HTTP)",
          message: `${e.method} ${e.path}  →  ${e.status ?? "?"}  took ${e.durationMs}ms`,
          durationMs: e.durationMs,
        });
      }
    }

    // RPC-level slow requests
    if (includeRpc) {
      const rpcSlow = await findSlowRpcRequests(logDir, args.files, thresholdMs, startTime, endTime);
      allSlow.push(...rpcSlow);
    }

    return formatSlowRequests(allSlow, {
      thresholdMs,
      limit: slowLimit,
      sortBy: slowSortBy,
      groupBy: args.slowGroupBy,
    });
  }

  // ── "totals" shortcut mode ──────────────────────────────────────────────
  // (fall through to normal processing with totalsOnly flag)

  // ── "rates" shortcut mode ───────────────────────────────────────────────
  // (fall through to normal processing with rateBy flag)

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return `No log files found for: ${args.files.join(", ")}`;

  const all: HttpRequest[] = [];
  for (const fp of paths) {
    const reqs = await parseHttpRequests(fp, startTime, endTime);
    all.push(...reqs);
  }

  if (all.length === 0) {
    return `No HTTP requests found in specified files.`;
  }

  // Filter
  let filtered = all.filter(r => {
    if (!isAssets && (r.path.startsWith("/assets/") || r.path.startsWith("/bundles/"))) return false;
    if (method && r.method.toUpperCase() !== method.toUpperCase()) return false;
    if (clientIp && !r.clientIp?.includes(clientIp)) return false;
    if (minDurationMs && (r.durationMs ?? 0) < minDurationMs) return false;
    if (statusFilter && statusFilter.length > 0 && !matchesStatusFilter(r.status, statusFilter)) return false;
    if (pathFilter) {
      try {
        if (!new RegExp(pathFilter, "i").test(r.path)) return false;
      } catch {
        if (!r.path.toLowerCase().includes(pathFilter.toLowerCase())) return false;
      }
    }
    return true;
  });

  const totalBeforeLimit = filtered.length;

  // ── Active window detection ───────────────────────────────────────────────
  // Walk filtered requests, bucket by minute, find peak minute, identify the
  // contiguous window where every minute ≥ 10% of peak, pad ±1 minute.
  let activeWindowBanner = "";
  if (detectActiveWindow && filtered.length > 0) {
    const perMinute = new Map<string, number>();
    const tsToMin = (ts: string): string => ts.slice(0, 5); // "HH:MM"
    for (const r of filtered) {
      if (!r.startedAt) continue;
      const m = tsToMin(r.startedAt);
      perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
    }
    const sorted = [...perMinute.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sorted.length > 0) {
      const maxCount = Math.max(...sorted.map(([, c]) => c));
      const threshold = Math.max(1, Math.floor(maxCount * 0.1));
      // Find contiguous run of minutes above threshold
      const above = sorted.filter(([, c]) => c >= threshold);
      if (above.length > 0) {
        // Expand by 1 minute either side
        const firstMin = above[0][0];
        const lastMin  = above[above.length - 1][0];
        const addMin = (hhmm: string, delta: number): string => {
          const [hh, mm] = hhmm.split(":").map(Number);
          const total = Math.max(0, hh * 60 + mm + delta);
          return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
        };
        const winStart = `${addMin(firstMin, -1)}:00`;
        const winEnd   = `${addMin(lastMin, 1)}:59`;
        activeWindowBanner = `Active window detected: ${winStart} → ${winEnd}  (peak ${maxCount} req/min, threshold ${threshold})\n`;
      }
    }
  }

  // ── totalsOnly mode ─────────────────────────────────────────────────────────
  if (totalsOnly) {
    const cls = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "???": 0 };
    let totalDurationMs = 0, durationCount = 0;
    for (const r of filtered) {
      const c = statusClassOf(r.status ?? 0) as keyof typeof cls;
      cls[c] = (cls[c] ?? 0) + 1;
      if (r.durationMs !== null) { totalDurationMs += r.durationMs; durationCount++; }
    }
    const total = filtered.length;
    const errors = cls["4xx"] + cls["5xx"];
    const errRate = total > 0 ? ((errors / total) * 100).toFixed(2) : "0.00";
    const avgMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0;
    const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
    return [
      activeWindowBanner,
      `HTTP totals — ${total.toLocaleString()} requests`,
      "",
      `  2xx  success   ${String(cls["2xx"]).padStart(8)}  ${pct(cls["2xx"])}`,
      `  3xx  redirect  ${String(cls["3xx"]).padStart(8)}  ${pct(cls["3xx"])}`,
      `  4xx  client    ${String(cls["4xx"]).padStart(8)}  ${pct(cls["4xx"])}`,
      `  5xx  server    ${String(cls["5xx"]).padStart(8)}  ${pct(cls["5xx"])}`,
      ...(cls["???"] > 0 ? [`  ???  unknown    ${String(cls["???"]).padStart(8)}  ${pct(cls["???"])}`] : []),
      "",
      `  Total errors   ${String(errors).padStart(8)}  error rate: ${errRate}%`,
      `  Avg duration   ${String(avgMs).padStart(8)} ms`,
    ].filter(Boolean).join("\n");
  }

  // ── rateBy mode (request rate over time) ──────────────────────────────────
  if (rateBy) {
    const bucketMs = rateBy === "hour" ? 3_600_000 : rateBy === "5min" ? 300_000 : 60_000;
    const bucketLabel = rateBy === "hour" ? "hour" : rateBy === "5min" ? "5 min" : "minute";

    type RateBucket = { count: number; errors: number; totalMs: number; maxMs: number };
    const buckets = new Map<string, RateBucket>();
    for (const r of filtered) {
      const ms = timestampToMs(r.startedAt);
      const bucketStart = Math.floor(ms / bucketMs) * bucketMs;
      const h = Math.floor(bucketStart / 3_600_000);
      const m = Math.floor((bucketStart % 3_600_000) / 60_000);
      const key = rateBy === "hour"
        ? `${String(h).padStart(2, "0")}:00`
        : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const b = buckets.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      b.count++;
      if ((r.status ?? 0) >= 400) b.errors++;
      if (r.durationMs !== null) {
        b.totalMs += r.durationMs;
        b.maxMs = Math.max(b.maxMs, r.durationMs);
      }
      buckets.set(key, b);
    }

    const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxCount = sortedBuckets.length > 0 ? Math.max(...sortedBuckets.map(([, b]) => b.count)) : 1;
    const BAR = 30;
    const title = pathFilter ? `"${pathFilter}"` : "all matched requests";
    const out: string[] = [
      activeWindowBanner,
      `Request rate per ${bucketLabel} for ${title}`,
      `Total: ${totalBeforeLimit} requests  |  method: ${method ?? "any"}  |  status: ${statusFilter?.join(",") ?? "any"}`,
      "",
    ];
    for (const [time, b] of sortedBuckets) {
      const bar = "█".repeat(Math.max(1, Math.round((b.count / maxCount) * BAR)));
      const avg = b.count > 0 ? `avg ${Math.round(b.totalMs / b.count)}ms` : "";
      const errStr = b.errors > 0 ? `  ⚠ ${b.errors} err` : "";
      out.push(`  ${time}  ${bar.padEnd(BAR + 1)}  ${String(b.count).padStart(5)}  ${avg}${errStr}`);
    }
    return out.join("\n");
  }

  // ── groupBy mode ────────────────────────────────────────────────────────────
  if (groupBy) {

    // ── status / statusClass ─────────────────────────────────────────────────
    if (groupBy === "status" || groupBy === "statusClass") {
      type SGroup = { label: string; count: number; totalMs: number; maxMs: number };
      const groups = new Map<string, SGroup>();

      for (const r of filtered) {
        const s = r.status ?? 0;
        const key = groupBy === "statusClass" ? statusClassOf(s) : String(s || "???");
        const label = groupBy === "statusClass"
          ? ({ "2xx": "2xx  success", "3xx": "3xx  redirect", "4xx": "4xx  client err", "5xx": "5xx  server err", "???": "???  unknown" }[key] ?? key)
          : key;
        const g = groups.get(key) ?? { label, count: 0, totalMs: 0, maxMs: 0 };
        g.count++;
        if (r.durationMs !== null) {
          g.totalMs += r.durationMs;
          g.maxMs = Math.max(g.maxMs, r.durationMs);
        }
        groups.set(key, g);
      }

      const total = filtered.length;
      const errors = filtered.filter(r => (r.status ?? 0) >= 400).length;
      const errRate = total > 0 ? ((errors / total) * 100).toFixed(2) : "0.00";

      const sortedGroups = [...groups.values()].sort((a, b) => {
        if (sortBy === "avg") return Math.round(b.totalMs / b.count) - Math.round(a.totalMs / a.count);
        if (sortBy === "count") return b.count - a.count;
        return a.label.localeCompare(b.label); // default: by status code ascending
      });

      const out = [
        activeWindowBanner,
        `HTTP request summary — grouped by ${groupBy === "statusClass" ? "status class" : "status code"}`,
        `Total requests matched: ${total.toLocaleString()}  |  error rate: ${errRate}%`,
        "",
        `${"Status".padEnd(20)} ${"Count".padStart(8)} ${"   %".padStart(7)} ${"Avg ms".padStart(8)} ${"Max ms".padStart(8)}`,
        "─".repeat(57),
      ];
      for (const g of sortedGroups) {
        const avg = g.count > 0 ? Math.round(g.totalMs / g.count) : 0;
        const pct = total > 0 ? ((g.count / total) * 100).toFixed(1) : "0.0";
        out.push(`${g.label.padEnd(20)} ${String(g.count).padStart(8)} ${pct.padStart(6)}% ${String(avg).padStart(8)} ${String(g.maxMs).padStart(8)}`);
      }
      return out.join("\n");
    }

    // ── path / client ────────────────────────────────────────────────────────
    type Group = { key: string; count: number; totalMs: number; maxMs: number; errors: number; lastSeen: string; statusCounts: Map<number, number> };
    const groups = new Map<string, Group>();

    for (const r of filtered) {
      const key = groupBy === "path"
        ? `${r.method} ${r.path}`
        : (r.clientIp ?? "(unknown)");

      const g = groups.get(key) ?? { key, count: 0, totalMs: 0, maxMs: 0, errors: 0, lastSeen: "", statusCounts: new Map() };
      g.count++;
      if (r.durationMs !== null) {
        g.totalMs += r.durationMs;
        g.maxMs = Math.max(g.maxMs, r.durationMs);
      }
      if ((r.status ?? 0) >= 400) g.errors++;
      if (r.status !== null) g.statusCounts.set(r.status, (g.statusCounts.get(r.status) ?? 0) + 1);
      if (r.startedAt > g.lastSeen) g.lastSeen = r.startedAt;
      groups.set(key, g);
    }

    const sorted = [...groups.values()].sort((a, b) => {
      if (sortBy === "avg") return Math.round(b.totalMs / b.count) - Math.round(a.totalMs / a.count);
      if (sortBy === "count") return b.count - a.count;
      if (sortBy === "errors") return b.errors - a.errors;
      return b.maxMs - a.maxMs; // default "max"
    }).slice(0, limit);
    const out = [
      activeWindowBanner,
      `HTTP request summary — grouped by ${groupBy}`,
      `Total requests matched: ${totalBeforeLimit}`,
      "",
      `${"Key".padEnd(55)} ${"Count".padStart(6)} ${"Avg ms".padStart(7)} ${"Max ms".padStart(7)} ${"Errors".padStart(7)}`,
      "─".repeat(90),
    ];
    for (const g of sorted) {
      const avg = g.count > 0 ? Math.round(g.totalMs / g.count) : 0;
      const topErrCodes = [...g.statusCounts.entries()]
        .filter(([s]) => s >= 400)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([s, c]) => `${s}×${c}`)
        .join(", ");
      const errSuffix = topErrCodes ? `  (${topErrCodes})` : "";
      out.push(
        `${g.key.slice(0, 54).padEnd(55)} ${String(g.count).padStart(6)} ${String(avg).padStart(7)} ${String(g.maxMs).padStart(7)} ${String(g.errors).padStart(7)}${errSuffix}`
      );
    }
    return out.join("\n");
  }

  // ── list mode ────────────────────────────────────────────────────────────────
  filtered.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const shown = filtered.slice(0, limit);

  const out = [
    activeWindowBanner,
    `Found ${totalBeforeLimit} HTTP request(s) — showing ${shown.length}`,
    "",
  ];

  for (const r of shown) {
    const status = r.status !== null ? String(r.status) : "???";
    const dur    = r.durationMs !== null ? `${r.durationMs}ms` : "(in-flight)";
    const ip     = r.clientIp ?? "(unknown)";
    const slow   = r.slowWarnings.length > 0 ? `  ⚠ slow: ${r.slowWarnings.map(n => n + "ms").join(", ")}` : "";
    out.push(`[${r.startedAt}] ${r.method} ${r.path}`);
    out.push(`    ${ip}  →  ${status}  ${dur}${slow}`);
  }

  if (totalBeforeLimit > limit) {
    out.push(`\n… ${totalBeforeLimit - limit} more (increase limit or narrow filter)`);
  }

  // Duration stats for requests with data
  const durations = shown.filter(r => r.durationMs !== null).map(r => r.durationMs as number);
  if (durations.length > 1) {
    const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const max = Math.max(...durations);
    const errors = shown.filter(r => (r.status ?? 0) >= 400).length;
    out.push(`\nStats: avg=${avg}ms  max=${max}ms  errors=${errors}/${shown.length}`);
  }

  return out.join("\n");
}

// ── Exported helper for slow-requests.ts ──────────────────────────────────────

export interface HttpSlowEntry {
  timestamp: string;
  durationMs: number;
  method: string;
  path: string;
  status: number | null;
  clientIp: string | null;
  file: string;
}

/** Find all HTTP requests exceeding `thresholdMs` in a single IS log file. */
export async function findSlowHttpRequests(
  fullPath: string,
  thresholdMs: number,
  startTime?: string,
  endTime?: string
): Promise<HttpSlowEntry[]> {
  const reqs = await parseHttpRequests(fullPath, startTime, endTime);
  return reqs
    .filter(r => r.durationMs !== null && r.durationMs >= thresholdMs)
    .map(r => ({
      timestamp: r.completedAt ?? r.startedAt,
      durationMs: r.durationMs as number,
      method: r.method,
      path: r.path,
      status: r.status,
      clientIp: r.clientIp,
      file: r.sourceFile,
    }));
}
