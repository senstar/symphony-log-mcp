import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import type { LogEntry } from "../lib/log-parser.js";
import { fingerprintShort } from "../lib/fingerprint.js";

/**
 * High-volume init chatter we do NOT want as lifecycle events.
 * These are sub-steps emitted by InfoService.Initialize and similar startup sequences.
 */
const NOISE_PATTERNS = [
  // Original step-based init chatter
  /STARTING\s*:\s*Executing initialization step/i,
  /FINISHED\s*:\s*Executing initialization step/i,
  /STARTING\s*:\s*Executing.*step\s+\d+/i,
  /FINISHED\s*:\s*Executing.*step\s+\d+/i,
  // Pipe-delimited sub-function instrumentation (ALL-CAPS STARTING/FINISHED + colon)
  // e.g. "ConfigUtils.LoadServerSettingsIntoDB | STARTING : Calculating values for..."
  //      "CachedCameraMetadataService.Initialize | FINISHED : Initializing ... (12 ms)"
  /\|\s*STARTING\s*:/,
  /\|\s*FINISHED\s*:/,
];

/** Keywords that indicate a service is starting or restarting */
const START_PATTERNS = [
  /starting/i,
  /startup completed/i,
  /service started/i,
  /\bstart\b.*version/i,
  /initializ/i,
];

/** Keywords that indicate a service is stopping or shutting down */
const STOP_PATTERNS = [
  /stopping/i,
  /shutting down/i,
  /shutdown/i,
  /service stopped/i,
  /exiting/i,
];

/** Keywords that indicate a forced restart or failover condition.
 *  Verified against source code:
 *  - "buddy" — farm failover (CFarmHealth.cs sends ALIVE to buddies)
 *  - "ALIVE" — farm heartbeat (30-second threshold per Signals.asmx.cs:8669)
 *  - "failover" — SAN/server failover (ResourceLocations.cpp, ControlRequest.cs)
 *  - "WallGetPanels" — video wall layout request (Signals.asmx.cs:9359)
 *  - "Database is down" — actual log message (Service.cpp:216)
 *  - "RestartMyself" — Tracker self-restart method (TrackerAx.cpp:921)
 *  NOTE: "too many timeouts on web broker threads", "database went away",
 *  "database came back", and "self-restart" do NOT exist in source code.
 */
const RESTART_REASON_PATTERNS = [
  /database.*is.*down/i,
  /restarting/i,
  /RestartMyself/i,
  /failover/i,
  /fail.*over/i,
  /lost connection/i,
  /reconnecting/i,
  /ping.*failed/i,
  /ping.*stopped/i,
  /server.*unreachable/i,
  /buddy.*lost/i,
  /buddy.*failed/i,
  /buddy.*down/i,
  /ALIVE.*failed/i,
  /not alive/i,
  /WallGetPanels/i,
  /timeout.*web.*broker/i,
  /too many timeouts/i,
];

interface LifecycleEvent {
  file: string;
  timestamp: string;
  threadId: string;
  type: "start" | "stop" | "restart-reason" | "ping";
  message: string;
}

/** Fingerprint a restart-cause message for deduplication — delegates to shared utility. */
const causeFingerprint = (message: string) => fingerprintShort(message, 120);

function classify(entry: LogEntry): "start" | "stop" | "restart-reason" | "ping" | null {
  const msg = entry.line.message;
  // Filter out high-volume init sub-step chatter first
  if (NOISE_PATTERNS.some((p) => p.test(msg))) return null;
  if (RESTART_REASON_PATTERNS.some((p) => p.test(msg))) return "restart-reason";
  if (STOP_PATTERNS.some((p) => p.test(msg))) return "stop";
  if (START_PATTERNS.some((p) => p.test(msg)) && entry.line.level !== "Error") return "start";
  if (/\bALIVE\b|\bPING\b|\bping\b|\bbuddy\b/i.test(msg)) return "ping";
  return null;
}

export async function toolGetServiceLifecycle(
  logDir: string | string[],
  args: {
    files: string[];
    includePings?: boolean;
    startTime?: string;
    endTime?: string;
    limit?: number;
  }
): Promise<string> {
  const limit = args.limit ?? 200;
  const includePings = args.includePings ?? false;

  const events: LifecycleEvent[] = [];
  const paths = await resolveFileRefs(args.files, logDir);

  for (const fullPath of paths) {
    const fileRef = fullPath.split(/[\\/]/).pop() ?? fullPath;
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const type = classify(entry);
      if (!type) continue;
      if (type === "ping" && !includePings) continue;

      events.push({
        file: fileRef,
        timestamp: entry.line.timestamp,
        threadId: entry.line.threadId,
        type,
        message: entry.line.message,
      });
    }
  }

  if (events.length === 0) {
    return "No lifecycle events found.";
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Deduplicate restart-cause events — show first, last, count per unique pattern
  interface CauseGroup { first: LifecycleEvent; last: LifecycleEvent; count: number; }
  const causeGroups = new Map<string, CauseGroup>();
  const nonCauseEvents: LifecycleEvent[] = [];

  for (const ev of events) {
    if (ev.type === "restart-reason") {
      const fp = causeFingerprint(ev.message);
      const g = causeGroups.get(fp);
      if (g) { g.count++; g.last = ev; }
      else causeGroups.set(fp, { first: ev, last: ev, count: 1 });
    } else {
      nonCauseEvents.push(ev);
    }
  }

  // Build combined output list: inline events + cause summaries, sorted by first-seen time
  interface OutputItem {
    timestamp: string;
    line1: string;
    line2: string;
  }

  const ICONS: Record<string, string> = {
    start: "▶ START",
    stop: "■ STOP ",
    "restart-reason": "⚠ CAUSE",
    ping: "~ PING ",
  };

  const items: OutputItem[] = [];

  for (const ev of nonCauseEvents) {
    items.push({
      timestamp: ev.timestamp,
      line1: `[${ev.timestamp}] ${ICONS[ev.type] ?? ev.type}  ${ev.message.slice(0, 200)}`,
      line2: `           File: ${ev.file}`,
    });
  }

  for (const [, g] of causeGroups) {
    const countStr = g.count > 1 ? ` ×${g.count} (last: ${g.last.timestamp})` : "";
    items.push({
      timestamp: g.first.timestamp,
      line1: `[${g.first.timestamp}] ⚠ CAUSE${countStr}  ${g.first.message.slice(0, 180)}`,
      line2: `           File: ${g.first.file}`,
    });
  }

  items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const shown = items.slice(0, limit);

  const totalDisplayed = nonCauseEvents.length + causeGroups.size;
  const out: string[] = [
    `Found ${events.length} lifecycle event(s) [${nonCauseEvents.length} start/stop, ${causeGroups.size} unique cause pattern(s) from ${causeGroups.size > 0 ? [...causeGroups.values()].reduce((s, g) => s + g.count, 0) : 0} occurrences] (showing ${shown.length}):`,
    "",
  ];

  for (const item of shown) {
    out.push(item.line1);
    out.push(item.line2);
    out.push("");
  }

  // Summary
  const counts = { start: 0, stop: 0, "restart-reason": 0, ping: 0 };
  for (const ev of events) counts[ev.type]++;
  out.push("--- Summary ---");
  out.push(`  Starts: ${counts.start}  Stops: ${counts.stop}  Restart causes: ${counts["restart-reason"]} (${causeGroups.size} unique pattern(s))  Pings: ${counts.ping}`);

  return out.join("\n");
}
