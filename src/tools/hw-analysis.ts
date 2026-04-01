/**
 * hw-analysis.ts
 *
 * Hardware integration analysis from Symphony IS logs:
 *   - Advantech device errors and timeouts
 *   - Access-control hardware (door controllers, card readers)
 *   - Hardware system connection failures
 *   - Device inventory from running configuration
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, appendWarnings } from "../lib/log-reader.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_ADVANTECH      = /\bAdvantech\b|\bADAM[-\s]?\d{4}\b|\badam[-_]?device\b/i;
const RE_HW_CONNECT     = /(?:hardware|device|controller)\s+(?:connect|disconnect|timeout|not\s+respond)/i;
const RE_SERIAL_PORT    = /(?:COM\d+|serial\s+port|RS-?232|RS-?485|Baud)/i;
const RE_IO_MODULE      = /(?:IO\s+module|input\s+module|output\s+module|DIO|digital\s+(?:in|out)put)/i;
const RE_DOOR_CTRL      = /(?:door\s+controller|access\s+controller|\bMercury\b|\bHID\b|\bWiegand\b)/i;
const RE_DEVICE_ERROR   = /(?:device|hardware).*(?:error|fail|exception|timeout|offline|unreachable)/i;
const RE_ADAM_ERROR      = /(?:ReadCoil|ReadStatus|WriteCoil|WriteRegister|WriteSingleCoil).*(?:fail|error|timeout|exception)/i;
const RE_IP_DEVICE       = /(?:device|module|controller)\s+(?:at\s+)?([\d.]+(?::\d+)?)/i;

interface HwEvent {
  timestamp: string;
  category: "advantech" | "serial" | "door" | "io_module" | "connection" | "error";
  severity: "info" | "warning" | "error";
  message: string;
  device?: string;
  file: string;
}

export interface HwArgs {
  mode: "summary" | "advantech" | "devices" | "errors";
  files?: string[];
  deviceFilter?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export async function toolHw(
  logDir: string | string[],
  args: HwArgs,
): Promise<string> {
  const { mode, limit = 50, deviceFilter, startTime, endTime } = args;

  let files = args.files;
  if (!files || files.length === 0) files = ["is", "ac", "hm"];
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return "No log files found. Try specifying files (e.g., 'is', 'ac', 'hm').";

  const events: HwEvent[] = [];
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, startTime, endTime)) continue;
      const msg = entry.line.message;
      const lvl = entry.line.level;

      let category: HwEvent["category"] | null = null;
      let device: string | undefined;

      // Advantech / ADAM
      if (RE_ADVANTECH.test(msg) || RE_ADAM_ERROR.test(msg)) {
        category = "advantech";
        const ipMatch = RE_IP_DEVICE.exec(msg);
        if (ipMatch) device = ipMatch[1];
      }

      // Serial port
      if (!category && RE_SERIAL_PORT.test(msg)) {
        category = "serial";
        const comMatch = /COM(\d+)/i.exec(msg);
        if (comMatch) device = `COM${comMatch[1]}`;
      }

      // Door / access controller
      if (!category && RE_DOOR_CTRL.test(msg)) {
        category = "door";
      }

      // IO module
      if (!category && RE_IO_MODULE.test(msg)) {
        category = "io_module";
      }

      // General hardware connection
      if (!category && RE_HW_CONNECT.test(msg)) {
        category = "connection";
      }

      // General device error
      if (!category && RE_DEVICE_ERROR.test(msg)) {
        category = "error";
      }

      if (!category) continue;

      if (deviceFilter) {
        if (device && !device.includes(deviceFilter)) continue;
        if (!device && !msg.toLowerCase().includes(deviceFilter.toLowerCase())) continue;
      }

      const severity: HwEvent["severity"] =
        lvl === "Error" ? "error" : "info";

      events.push({
        timestamp: entry.line.timestamp,
        category,
        severity,
        message: msg.slice(0, 200),
        device,
        file: fileRef,
      });
    }
  }

  if (events.length === 0) {
    return appendWarnings("No hardware-related events found" +
      (deviceFilter ? ` matching '${deviceFilter}'` : "") + ".", warnings);
  }

  switch (mode) {
    case "summary":
      return appendWarnings(formatHwSummary(events), warnings);
    case "advantech":
      return appendWarnings(formatAdvantech(events, limit), warnings);
    case "devices":
      return appendWarnings(formatDevices(events, limit), warnings);
    case "errors":
      return appendWarnings(formatHwErrors(events, limit), warnings);
    default:
      return `Unknown mode '${mode}'. Use: summary, advantech, devices, errors`;
  }
}

function formatHwSummary(events: HwEvent[]): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  HARDWARE INTEGRATION SUMMARY");
  out.push("═".repeat(60));
  out.push("");

  // Category counts
  const byCat = new Map<string, number>();
  for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

  out.push("Event Categories:");
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(count).padStart(6)}×  ${cat.replace(/_/g, " ")}`);
  }
  out.push("");

  // Severity breakdown
  const bySev = new Map<string, number>();
  for (const e of events) bySev.set(e.severity, (bySev.get(e.severity) ?? 0) + 1);
  out.push(`Severity:  Errors: ${bySev.get("error") ?? 0}  |  Warnings: ${bySev.get("warning") ?? 0}  |  Info: ${bySev.get("info") ?? 0}`);
  out.push("");

  // Known devices
  const devices = new Map<string, number>();
  for (const e of events) {
    if (e.device) devices.set(e.device, (devices.get(e.device) ?? 0) + 1);
  }
  if (devices.size > 0) {
    out.push("Known Devices:");
    for (const [dev, count] of [...devices.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      out.push(`  ${String(count).padStart(6)}×  ${dev}`);
    }
  }

  out.push("");
  out.push(`Total events: ${events.length}  |  Time: ${events[0].timestamp} → ${events[events.length - 1].timestamp}`);
  out.push("═".repeat(60));
  return out.join("\n");
}

function formatAdvantech(events: HwEvent[], limit: number): string {
  const advEvents = events.filter(e => e.category === "advantech");
  const out: string[] = [];
  out.push(`Found ${advEvents.length} Advantech event(s) (showing ${Math.min(advEvents.length, limit)}):`);
  out.push("");

  if (advEvents.length === 0) {
    out.push("  No Advantech/ADAM events found.");
    return out.join("\n");
  }

  for (const e of advEvents.slice(0, limit)) {
    const icon = e.severity === "error" ? "✗" : e.severity === "warning" ? "~" : "·";
    out.push(`  ${icon} [${e.timestamp}] ${e.device ? `[${e.device}] ` : ""}${e.message.slice(0, 120)}`);
  }

  return out.join("\n");
}

function formatDevices(events: HwEvent[], limit: number): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  HARDWARE DEVICE INVENTORY");
  out.push("═".repeat(60));
  out.push("");

  const deviceMap = new Map<string, { count: number; errors: number; categories: Set<string>; lastSeen: string }>();

  for (const e of events) {
    const key = e.device ?? `[unknown-${e.category}]`;
    const info = deviceMap.get(key) ?? { count: 0, errors: 0, categories: new Set<string>(), lastSeen: "" };
    info.count++;
    if (e.severity === "error") info.errors++;
    info.categories.add(e.category);
    info.lastSeen = e.timestamp;
    deviceMap.set(key, info);
  }

  const sorted = [...deviceMap.entries()].sort((a, b) => b[1].errors - a[1].errors).slice(0, limit);

  out.push(`${"Device".padEnd(25)} ${"Events".padStart(6)} ${"Errors".padStart(6)}  ${"Type"}`);
  out.push("─".repeat(60));

  for (const [dev, info] of sorted) {
    const icon = info.errors > 10 ? "✗" : info.errors > 0 ? "~" : "✓";
    out.push(`${(icon + " " + dev).padEnd(25)} ${String(info.count).padStart(6)} ${String(info.errors).padStart(6)}  ${[...info.categories].join(", ")}`);
  }

  out.push("═".repeat(60));
  return out.join("\n");
}

function formatHwErrors(events: HwEvent[], limit: number): string {
  const errors = events.filter(e => e.severity === "error");
  const out: string[] = [];
  out.push(`Found ${errors.length} hardware error(s) (showing ${Math.min(errors.length, limit)}):`);
  out.push("");

  for (const e of errors.slice(0, limit)) {
    out.push(`  ✗ [${e.timestamp}] [${e.category}] ${e.device ? `[${e.device}] ` : ""}${e.message.slice(0, 120)}`);
  }

  return out.join("\n");
}
