/**
 * alarms.ts
 *
 * Parse Scheduler action logs (scac) for alarm/event rule processing:
 *   - Alarm and event rule triggers
 *   - Notification delivery (email, relay, output)
 *   - Rule evaluation failures
 *   - Action execution timing
 */

import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_ALARM_TRIGGER  = /(?:alarm\s+(?:trigger|fire|activate|raise)|event\s+(?:trigger|fire|raise)|rule\s+(?:trigger|fire|match))/i;
const RE_ALARM_CLEAR    = /(?:alarm\s+(?:clear|reset|acknowledge|ack|deactivate)|event\s+(?:clear|reset))/i;
const RE_NOTIFICATION   = /(?:send(?:ing)?\s+(?:email|notification|alert|message)|email\s+(?:sent|send|deliver)|relay\s+(?:activat|trigger|fire)|output\s+(?:activat|trigger|set))/i;
const RE_NOTIF_FAIL     = /(?:(?:email|notification|relay|output)\s+(?:fail|error|timeout)|failed\s+to\s+(?:send|deliver|activate))/i;
const RE_RULE_EVAL      = /(?:evaluat(?:e|ing)\s+(?:rule|condition|trigger|schedule)|rule\s+(?:evaluat|check|process))/i;
const RE_RULE_FAIL      = /(?:rule\s+(?:error|fail|exception)|evaluat.*(?:error|fail|exception))/i;
const RE_ACTION_EXEC    = /(?:execut(?:e|ing)\s+action|action\s+(?:start|run|execut)|perform(?:ing)?\s+action)/i;
const RE_ACTION_DONE    = /(?:action\s+(?:complete|done|finish|success)|execut.*(?:complete|done|finish))/i;

interface AlarmEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "trigger" | "clear" | "notification" | "notif_fail" | "rule_eval" | "rule_fail" | "action_exec" | "action_done";
  message: string;
  source: string;
  file: string;
}

export async function toolAlarms(
  logDir: string | string[],
  args: {
    files: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
    mode?: "summary" | "events" | "failures";
  }
): Promise<string> {
  const limit = args.limit ?? 100;
  const mode = args.mode ?? "summary";

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return `No log files found for: ${args.files.join(", ")}`;

  const events: AlarmEvent[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const msg = entry.line.message;

      let category: AlarmEvent["category"] | null = null;
      if (RE_NOTIF_FAIL.test(msg))         category = "notif_fail";
      else if (RE_RULE_FAIL.test(msg))     category = "rule_fail";
      else if (RE_ALARM_TRIGGER.test(msg)) category = "trigger";
      else if (RE_ALARM_CLEAR.test(msg))   category = "clear";
      else if (RE_NOTIFICATION.test(msg))  category = "notification";
      else if (RE_ACTION_DONE.test(msg))   category = "action_done";
      else if (RE_ACTION_EXEC.test(msg))   category = "action_exec";
      else if (RE_RULE_EVAL.test(msg))     category = "rule_eval";

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
    return `No alarm/event rule activity found in ${paths.length} file(s).`;
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const out: string[] = [];

  if (mode === "summary") {
    const byCat = new Map<string, number>();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

    out.push(`Alarms & Events Summary — ${events.length} events across ${paths.length} file(s)`);
    out.push("");

    const labels: Record<string, string> = {
      trigger: "Alarm triggers",
      clear: "Alarm clears",
      notification: "Notifications sent",
      notif_fail: "Notification failures",
      rule_eval: "Rule evaluations",
      rule_fail: "Rule failures",
      action_exec: "Actions executed",
      action_done: "Actions completed",
    };

    for (const [cat, label] of Object.entries(labels)) {
      const count = byCat.get(cat) ?? 0;
      if (count > 0) {
        const indicator = (cat === "notif_fail" || cat === "rule_fail") ? "⚠" : " ";
        out.push(`  ${indicator} ${label.padEnd(24)} ${count}`);
      }
    }

    const failures = events.filter(e => e.category === "notif_fail" || e.category === "rule_fail");
    if (failures.length > 0) {
      out.push("");
      out.push(`Failures (last ${Math.min(5, failures.length)}):`);
      for (const e of failures.slice(-5)) {
        out.push(`  [${e.timestamp}] ${e.source}: ${e.message.slice(0, 140)}`);
      }
    }
  } else if (mode === "events") {
    out.push(`Alarm Events — ${events.length} total (showing ${Math.min(limit, events.length)}):`);
    out.push("");
    for (const e of events.slice(0, limit)) {
      const tag = e.category.replace("_", " ").padEnd(14);
      out.push(`[${e.timestamp}] ${tag} <${e.level.padEnd(9)}> ${e.source}: ${e.message.slice(0, 140)}`);
    }
    if (events.length > limit) out.push(`\n… ${events.length - limit} more events`);
  } else if (mode === "failures") {
    const failures = events.filter(e => e.category === "notif_fail" || e.category === "rule_fail");
    if (failures.length === 0) {
      out.push("No alarm/notification failures found.");
    } else {
      out.push(`Alarm Failures — ${failures.length} total (showing ${Math.min(limit, failures.length)}):`);
      out.push("");
      for (const e of failures.slice(0, limit)) {
        out.push(`[${e.timestamp}] ${e.category.replace("_", " ")} <${e.level}> ${e.source}`);
        out.push(`  ${e.message.slice(0, 180)}`);
        out.push(`  File: ${e.file}`);
        out.push("");
      }
    }
  }

  return out.join("\n");
}
