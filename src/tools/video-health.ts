/**
 * video-health.ts
 *
 * Analyze Tracker (cs*), VCD formatter (vcd), and history sender (hs*) logs
 * for video pipeline health issues:
 *   - Camera connection/disconnection events
 *   - Frame drops, codec errors, decoder failures
 *   - Storage write failures
 *   - Recording gaps
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, listLogFiles, appendWarnings } from "../lib/log-reader.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_CAM_DISCONNECT = /(?:\bdisconnect(?:ed|ing)?\b|connection\s+(?:lost|closed|failed|dropped|reset))/i;
const RE_CAM_RECONNECT  = /(?:\breconnect(?:ed|ing)?\b|connection\s+(?:restored|re-?established|recovered))/i;
const RE_CAM_CONNECT    = /(?:\bconnect(?:ed|ing)?\b|connection\s+(?:established|opened))/i;
const RE_FRAME_DROP     = /(?:frame\s*drop|dropped?\s+frame|buffer\s+(?:overflow|full|overrun))/i;
const RE_CODEC_ERROR    = /(?:codec\s+error|decode\s+(?:error|fail)|encoder\s+(?:error|fail)|h\.?26[45]\s+error|jpeg\s+error)/i;
const RE_STORAGE_FAIL   = /(?:storage\s+(?:write|error|fail)|write\s+(?:error|fail)|disk\s+(?:full|error))/i;
const RE_RECORDING_GAP  = /(?:recording\s+(?:gap|stopped|interrupted|paused)|no\s+data\s+received)/i;
const RE_CAMERA_STATUS  = /(?:camera\s+(?:\d+|#\d+)|device\s+\d+)/i;
const RE_STREAM_START   = /(?:stream\s+(?:start|open|request)|start(?:ing)?\s+(?:stream|video|live))/i;
const RE_STREAM_STOP    = /(?:stream\s+(?:stop|close|end)|stop(?:ping)?\s+(?:stream|video|live))/i;

interface VideoEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "connection" | "disconnect" | "reconnect" | "frame_drop" | "codec_error" | "storage_fail" | "recording_gap" | "stream_start" | "stream_stop";
  message: string;
  source: string;
  file: string;
}

export async function toolVideoHealth(
  logDir: string | string[],
  args: {
    files?: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
    mode?: "summary" | "events" | "cameras";
  }
): Promise<string> {
  const limit = args.limit ?? 100;
  const mode = args.mode ?? "summary";

  let files = args.files;
  if (!files || files.length === 0) {
    files = ["cs", "vcd", "hs"];
  }
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return `No video health log files found. Try specifying files explicitly (cs*, vcd*, hs* prefixes).`;

  const events: VideoEvent[] = [];
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const msg = entry.line.message;

      let category: VideoEvent["category"] | null = null;
      if (RE_CAM_DISCONNECT.test(msg))       category = "disconnect";
      else if (RE_CAM_RECONNECT.test(msg))   category = "reconnect";
      else if (RE_CAM_CONNECT.test(msg))     category = "connection";
      else if (RE_FRAME_DROP.test(msg))  category = "frame_drop";
      else if (RE_CODEC_ERROR.test(msg)) category = "codec_error";
      else if (RE_STORAGE_FAIL.test(msg)) category = "storage_fail";
      else if (RE_RECORDING_GAP.test(msg)) category = "recording_gap";
      else if (RE_STREAM_START.test(msg)) category = "stream_start";
      else if (RE_STREAM_STOP.test(msg)) category = "stream_stop";

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
    return appendWarnings(`No video pipeline events found in ${paths.length} file(s).`, warnings);
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const out: string[] = [];

  if (mode === "summary") {
    const byCat = new Map<string, number>();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

    out.push(`Video Health Summary — ${events.length} events across ${paths.length} file(s)`);
    out.push("");

    const categoryLabels: Record<string, string> = {
      connection: "Camera connects",
      disconnect: "Camera disconnects",
      reconnect: "Camera reconnects",
      frame_drop: "Frame drops",
      codec_error: "Codec errors",
      storage_fail: "Storage failures",
      recording_gap: "Recording gaps",
      stream_start: "Stream starts",
      stream_stop: "Stream stops",
    };

    for (const [cat, label] of Object.entries(categoryLabels)) {
      const count = byCat.get(cat) ?? 0;
      if (count > 0) {
        const indicator = (cat === "disconnect" || cat === "frame_drop" || cat === "codec_error" || cat === "storage_fail" || cat === "recording_gap")
          ? "⚠" : (cat === "reconnect" ? "↻" : " ");
        out.push(`  ${indicator} ${label.padEnd(22)} ${count}`);
      }
    }

    // Show first/last event times
    out.push("");
    out.push(`  First event: ${events[0].timestamp}`);
    out.push(`  Last event:  ${events[events.length - 1].timestamp}`);

    // If there are errors, show worst 5
    const errors = events.filter(e => ["disconnect", "frame_drop", "codec_error", "storage_fail", "recording_gap"].includes(e.category));
    if (errors.length > 0) {
      out.push("");
      out.push(`Recent issues (last ${Math.min(5, errors.length)}):`);
      for (const e of errors.slice(-5)) {
        out.push(`  [${e.timestamp}] ${e.category.replace("_", " ")} — ${e.source}: ${e.message.slice(0, 120)}`);
      }
    }
  } else if (mode === "events") {
    out.push(`Video Pipeline Events — ${events.length} total (showing ${Math.min(limit, events.length)}):`);
    out.push("");
    for (const e of events.slice(0, limit)) {
      const tag = e.category.replace("_", " ").padEnd(14);
      out.push(`[${e.timestamp}] ${tag} <${e.level.padEnd(9)}> ${e.source}: ${e.message.slice(0, 140)}`);
      out.push(`  File: ${e.file}`);
    }
    if (events.length > limit) out.push(`\n… ${events.length - limit} more events`);
  } else if (mode === "cameras") {
    // Group events by source (which often correlates to a camera tracker context)
    const bySource = new Map<string, VideoEvent[]>();
    for (const e of events) {
      const key = e.source;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(e);
    }
    const sorted = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length);
    out.push(`Video events grouped by source (${sorted.length} sources):`);
    out.push("");
    for (const [src, srcEvents] of sorted.slice(0, limit)) {
      const cats = new Map<string, number>();
      for (const e of srcEvents) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
      const catStr = [...cats.entries()].map(([c, n]) => `${c.replace("_", " ")}×${n}`).join(", ");
      out.push(`  ${src}  (${srcEvents.length} events): ${catStr}`);
    }
  }

  if (warnings.length > 0) { out.push(""); out.push(...warnings); }
  return out.join("\n");
}
