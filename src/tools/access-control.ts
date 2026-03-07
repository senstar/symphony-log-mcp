/**
 * access-control.ts
 *
 * Parse access control integration logs (ac, aacl, lacl, ga) for:
 *   - Door events and credential scans
 *   - Integration sync status
 *   - Communication failures with access control panels
 *   - Connection lifecycle with external AC systems
 */

import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import { fingerprint } from "../lib/fingerprint.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_DOOR_EVENT     = /(?:door\s+(?:open|close|lock|unlock|force|held)|access\s+(?:grant|deni|allow|reject))/i;
const RE_CREDENTIAL     = /(?:credential|card\s+(?:read|swipe|scan|present)|badge|keycard|PIN)/i;
const RE_SYNC           = /(?:sync(?:hroniz)?(?:e|ed|ing)?|import(?:ed|ing)?|export(?:ed|ing)?|poll(?:ed|ing)?)/i;
const RE_SYNC_FAIL      = /(?:sync.*(?:fail|error)|failed\s+to\s+sync|import.*(?:fail|error))/i;
const RE_COMM_FAIL      = /(?:communication\s+(?:fail|error|lost|timeout)|panel\s+(?:offline|unreachable|timeout)|controller\s+(?:offline|error))/i;
const RE_COMM_OK        = /(?:communication\s+(?:restored|established|ok)|panel\s+(?:online|connected)|controller\s+(?:online|connected))/i;
const RE_CONFIG_CHANGE  = /(?:config(?:uration)?\s+(?:change|update|modify)|rule\s+(?:add|remove|change|update))/i;

interface AccessControlEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "door_event" | "credential" | "sync" | "sync_fail" | "comm_fail" | "comm_ok" | "config_change";
  message: string;
  source: string;
  file: string;
}

export async function toolAccessControl(
  logDir: string | string[],
  args: {
    files: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
    mode?: "summary" | "events" | "failures" | "sync";
  }
): Promise<string> {
  const limit = args.limit ?? 100;
  const mode = args.mode ?? "summary";

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return `No log files found for: ${args.files.join(", ")}`;

  const events: AccessControlEvent[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const msg = entry.line.message;

      let category: AccessControlEvent["category"] | null = null;
      if (RE_SYNC_FAIL.test(msg))         category = "sync_fail";
      else if (RE_COMM_FAIL.test(msg))    category = "comm_fail";
      else if (RE_COMM_OK.test(msg))      category = "comm_ok";
      else if (RE_DOOR_EVENT.test(msg))   category = "door_event";
      else if (RE_CREDENTIAL.test(msg))   category = "credential";
      else if (RE_SYNC.test(msg))         category = "sync";
      else if (RE_CONFIG_CHANGE.test(msg)) category = "config_change";

      if (category) {
        events.push({
          timestamp: entry.line.timestamp,
          timestampMs: entry.line.timestampMs,
          level: entry.line.level,
          category,
          message: msg.slice(0, 200),
          source: entry.line.source,
          file: fileRef,
        });
      }
    }
  }

  if (events.length === 0) {
    return `No access control events found in ${paths.length} file(s).`;
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const out: string[] = [];

  if (mode === "summary") {
    const byCat = new Map<string, number>();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

    out.push(`Access Control Summary — ${events.length} events across ${paths.length} file(s)`);
    out.push("");

    const labels: Record<string, string> = {
      door_event: "Door events",
      credential: "Credential scans",
      sync: "Sync operations",
      sync_fail: "Sync failures",
      comm_fail: "Communication failures",
      comm_ok: "Communication restored",
      config_change: "Configuration changes",
    };

    for (const [cat, label] of Object.entries(labels)) {
      const count = byCat.get(cat) ?? 0;
      if (count > 0) {
        const indicator = (cat === "sync_fail" || cat === "comm_fail") ? "⚠" : " ";
        out.push(`  ${indicator} ${label.padEnd(26)} ${count}`);
      }
    }

    const failures = events.filter(e => e.category === "sync_fail" || e.category === "comm_fail");
    if (failures.length > 0) {
      out.push("");
      out.push(`Issues (last ${Math.min(5, failures.length)}):`);
      for (const e of failures.slice(-5)) {
        out.push(`  [${e.timestamp}] ${e.category.replace("_", " ")} — ${e.source}: ${e.message.slice(0, 120)}`);
      }
    }

  } else if (mode === "events") {
    out.push(`Access Control Events — ${events.length} total (showing ${Math.min(limit, events.length)}):`);
    out.push("");
    for (const e of events.slice(0, limit)) {
      const tag = e.category.replace("_", " ").padEnd(14);
      out.push(`[${e.timestamp}] ${tag} <${e.level.padEnd(9)}> ${e.source}: ${e.message.slice(0, 140)}`);
    }
    if (events.length > limit) out.push(`\n… ${events.length - limit} more events`);

  } else if (mode === "failures") {
    const failures = events.filter(e => e.category === "sync_fail" || e.category === "comm_fail");
    if (failures.length === 0) {
      out.push("No access control failures found.");
    } else {
      // Group by fingerprint for deduplication
      const byFp = new Map<string, { count: number; first: AccessControlEvent; last: AccessControlEvent }>();
      for (const e of failures) {
        const fp = fingerprint(e.message);
        const g = byFp.get(fp) ?? { count: 0, first: e, last: e };
        g.count++;
        g.last = e;
        byFp.set(fp, g);
      }
      const sorted = [...byFp.values()].sort((a, b) => b.count - a.count);
      out.push(`Access Control Failures — ${failures.length} total, ${sorted.length} unique patterns:`);
      out.push("");
      for (const g of sorted.slice(0, limit)) {
        out.push(`  ${String(g.count).padStart(4)}× [${g.first.timestamp}–${g.last.timestamp}] ${g.first.source}`);
        out.push(`       ${g.first.message.slice(0, 160)}`);
        out.push("");
      }
    }

  } else if (mode === "sync") {
    const syncEvents = events.filter(e => e.category === "sync" || e.category === "sync_fail");
    if (syncEvents.length === 0) {
      out.push("No sync events found.");
    } else {
      out.push(`Sync Activity — ${syncEvents.length} events:`);
      out.push("");
      const successes = syncEvents.filter(e => e.category === "sync").length;
      const failures = syncEvents.filter(e => e.category === "sync_fail").length;
      out.push(`  Successful syncs: ${successes}`);
      out.push(`  Failed syncs:     ${failures}`);
      if (syncEvents.length > 0) {
        out.push(`  First: ${syncEvents[0].timestamp}`);
        out.push(`  Last:  ${syncEvents[syncEvents.length - 1].timestamp}`);
      }
      out.push("");
      out.push(`Recent sync events (last ${Math.min(10, syncEvents.length)}):`);
      for (const e of syncEvents.slice(-10)) {
        const status = e.category === "sync_fail" ? "⚠ FAIL" : "  OK  ";
        out.push(`  [${e.timestamp}] ${status} ${e.source}: ${e.message.slice(0, 120)}`);
      }
    }
  }

  return out.join("\n");
}
