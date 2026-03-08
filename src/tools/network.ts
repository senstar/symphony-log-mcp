/**
 * network.ts
 *
 * Extract connection and network events from any Symphony log:
 *   - TCP connect/disconnect patterns
 *   - Timeout frequency and targets
 *   - Connection retry/reconnect activity
 *   - Build a connectivity timeline across services
 */

import { readLogEntries, resolveFileRefs, isInTimeWindow, listLogFiles } from "../lib/log-reader.js";
import { fingerprint } from "../lib/fingerprint.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_CONNECT      = /(?:connect(?:ed|ion)\s+(?:to|established|opened|succeed)|successfully\s+connect)/i;
const RE_DISCONNECT   = /(?:disconnect(?:ed)?|connection\s+(?:lost|closed|dropped|reset|broken)|socket\s+(?:closed|reset))/i;
const RE_TIMEOUT      = /(?:timed?\s*out|timeout|connection\s+timeout|request\s+timeout|socket\s+timeout)/i;
const RE_RETRY        = /(?:retry|reconnect|re-connect|attempt(?:ing)?\s+(?:connection|reconnect))/i;
const RE_REFUSED      = /(?:connection\s+refused|actively\s+refused|no\s+connection\s+could\s+be\s+made|ECONNREFUSED)/i;
const RE_DNS          = /(?:DNS|name\s+resolution|could\s+not\s+resolve|host\s+not\s+found|ENOTFOUND)/i;

// IP:port extraction
const RE_IP_PORT      = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?)/;

interface NetworkEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "connect" | "disconnect" | "timeout" | "retry" | "refused" | "dns";
  target: string;       // IP:port if found
  message: string;
  source: string;
  file: string;
}

export async function toolNetwork(
  logDir: string | string[],
  args: {
    files?: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
    mode?: "summary" | "events" | "targets" | "timeouts";
    targetFilter?: string;
  }
): Promise<string> {
  const limit = args.limit ?? 100;
  const mode = args.mode ?? "summary";
  const targetFilter = args.targetFilter?.toLowerCase();

  let files = args.files;
  if (!files || files.length === 0) {
    const allFiles = await listLogFiles(logDir);
    files = [...new Set(allFiles.map(f => f.prefix))];
  }
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return `No log files found in the log directory.`;

  const events: NetworkEvent[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const msg = entry.line.message;

      let category: NetworkEvent["category"] | null = null;
      if (RE_REFUSED.test(msg))        category = "refused";
      else if (RE_DNS.test(msg))       category = "dns";
      else if (RE_TIMEOUT.test(msg))   category = "timeout";
      else if (RE_RETRY.test(msg))     category = "retry";
      else if (RE_DISCONNECT.test(msg)) category = "disconnect";
      else if (RE_CONNECT.test(msg))   category = "connect";

      if (!category) continue;

      const ipMatch = RE_IP_PORT.exec(msg);
      const target = ipMatch?.[1] ?? "";

      if (targetFilter && !target.includes(targetFilter) && !msg.toLowerCase().includes(targetFilter)) continue;

      events.push({
        timestamp: entry.line.timestamp,
        timestampMs: entry.line.timestampMs,
        level: entry.line.level,
        category,
        target,
        message: msg.slice(0, 200),
        source: entry.line.source,
        file: fileRef,
      });
    }
  }

  if (events.length === 0) {
    return `No network events found in ${paths.length} file(s).`;
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const out: string[] = [];

  if (mode === "summary") {
    const byCat = new Map<string, number>();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

    out.push(`Network Summary — ${events.length} events across ${paths.length} file(s)`);
    out.push("");

    const labels: Record<string, string> = {
      connect: "Connections established",
      disconnect: "Disconnections",
      timeout: "Timeouts",
      retry: "Retries/reconnects",
      refused: "Connection refused",
      dns: "DNS issues",
    };

    for (const [cat, label] of Object.entries(labels)) {
      const count = byCat.get(cat) ?? 0;
      if (count > 0) {
        const indicator = (cat === "timeout" || cat === "refused" || cat === "dns") ? "⚠" : " ";
        out.push(`  ${indicator} ${label.padEnd(26)} ${count}`);
      }
    }

    // Top targets with problems
    const problemEvents = events.filter(e => ["timeout", "refused", "disconnect", "dns"].includes(e.category));
    const byTarget = new Map<string, number>();
    for (const e of problemEvents) {
      if (e.target) byTarget.set(e.target, (byTarget.get(e.target) ?? 0) + 1);
    }
    if (byTarget.size > 0) {
      const sortedTargets = [...byTarget.entries()].sort((a, b) => b[1] - a[1]);
      out.push("");
      out.push(`Problem targets (top ${Math.min(10, sortedTargets.length)}):`);
      for (const [target, count] of sortedTargets.slice(0, 10)) {
        out.push(`  ${target.padEnd(24)} ${count} issue(s)`);
      }
    }

  } else if (mode === "events") {
    out.push(`Network Events — ${events.length} total (showing ${Math.min(limit, events.length)}):`);
    out.push("");
    for (const e of events.slice(0, limit)) {
      const tag = e.category.padEnd(12);
      out.push(`[${e.timestamp}] ${tag} ${e.target.padEnd(21)} ${e.source}: ${e.message.slice(0, 120)}`);
    }
    if (events.length > limit) out.push(`\n… ${events.length - limit} more events`);

  } else if (mode === "targets") {
    const byTarget = new Map<string, { events: NetworkEvent[]; cats: Map<string, number> }>();
    for (const e of events) {
      const key = e.target || "(no target)";
      if (!byTarget.has(key)) byTarget.set(key, { events: [], cats: new Map() });
      const g = byTarget.get(key)!;
      g.events.push(e);
      g.cats.set(e.category, (g.cats.get(e.category) ?? 0) + 1);
    }
    const sorted = [...byTarget.entries()].sort((a, b) => b[1].events.length - a[1].events.length);
    out.push(`Network events by target (${sorted.length} targets):`);
    out.push("");
    for (const [target, g] of sorted.slice(0, limit)) {
      const catStr = [...g.cats.entries()].map(([c, n]) => `${c}×${n}`).join(", ");
      out.push(`  ${target.padEnd(24)} ${String(g.events.length).padStart(5)} events  (${catStr})`);
    }

  } else if (mode === "timeouts") {
    const timeouts = events.filter(e => e.category === "timeout" || e.category === "refused");
    if (timeouts.length === 0) {
      out.push("No timeouts or connection refused events found.");
    } else {
      // Group by fingerprint for deduplication
      const byFp = new Map<string, { count: number; first: NetworkEvent; last: NetworkEvent }>();
      for (const e of timeouts) {
        const fp = fingerprint(e.message);
        const g = byFp.get(fp) ?? { count: 0, first: e, last: e };
        g.count++;
        g.last = e;
        byFp.set(fp, g);
      }
      const sorted = [...byFp.values()].sort((a, b) => b.count - a.count);
      out.push(`Timeout/Refused Patterns — ${timeouts.length} total, ${sorted.length} unique:`);
      out.push("");
      for (const g of sorted.slice(0, limit)) {
        out.push(`  ${String(g.count).padStart(4)}× [${g.first.timestamp}–${g.last.timestamp}] ${g.first.source}`);
        out.push(`       ${g.first.message.slice(0, 160)}`);
        out.push("");
      }
    }
  }

  return out.join("\n");
}
