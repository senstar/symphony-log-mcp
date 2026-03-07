/**
 * storage.ts
 *
 * Analyze Cleaner (sccl) and related logs for storage management events:
 *   - Disk space warnings and thresholds
 *   - Retention enforcement activity (file deletions, cleanup runs)
 *   - Storage full / low-disk events
 *   - Deletion rate and cleanup patterns
 */

import { readLogEntries, resolveFileRefs, isInTimeWindow } from "../lib/log-reader.js";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_DISK_WARN    = /(?:disk\s+space\s+(?:low|warning|critical)|low\s+disk|free\s+(?:space|disk).*(?:below|less\s+than|under))/i;
const RE_DISK_FULL    = /(?:disk\s+(?:full|out\s+of\s+space)|no\s+(?:space|disk)\s+left|storage\s+full|insufficient\s+(?:disk|storage))/i;
const RE_RETENTION    = /(?:retention|expir|purg|age-off|cleanup)/i;
const RE_DELETE       = /(?:delet(?:e|ed|ing)\s+(?:file|video|recording|footage|data)|remov(?:e|ed|ing)\s+(?:file|video|data))/i;
const RE_CLEANER_RUN  = /(?:cleaner\s+(?:start|run|cycle|pass|scan)|cleanup\s+(?:start|run|cycle))/i;
const RE_CLEANER_DONE = /(?:cleaner\s+(?:finish|complete|done|end)|cleanup\s+(?:finish|complete|done|end))/i;
const RE_SPACE_INFO   = /(?:free[\s:]+\d|available[\s:]+\d|capacity[\s:]+\d|used[\s:]+\d|total[\s:]+\d)/i;
const RE_THRESHOLD    = /(?:threshold|watermark|limit|quota)/i;

interface StorageEvent {
  timestamp: string;
  timestampMs: number;
  level: string;
  category: "disk_warning" | "disk_full" | "retention" | "delete" | "cleaner_start" | "cleaner_done" | "space_info" | "threshold";
  message: string;
  source: string;
  file: string;
}

export async function toolStorage(
  logDir: string | string[],
  args: {
    files: string[];
    startTime?: string;
    endTime?: string;
    limit?: number;
    mode?: "summary" | "events" | "timeline";
  }
): Promise<string> {
  const limit = args.limit ?? 100;
  const mode = args.mode ?? "summary";

  const paths = await resolveFileRefs(args.files, logDir);
  if (paths.length === 0) return `No log files found for: ${args.files.join(", ")}`;

  const events: StorageEvent[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    let entries;
    try {
      entries = await readLogEntries(fullPath);
    } catch { continue; }

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, args.startTime, args.endTime)) continue;
      const msg = entry.line.message;

      let category: StorageEvent["category"] | null = null;
      if (RE_DISK_FULL.test(msg))         category = "disk_full";
      else if (RE_DISK_WARN.test(msg))    category = "disk_warning";
      else if (RE_CLEANER_RUN.test(msg))  category = "cleaner_start";
      else if (RE_CLEANER_DONE.test(msg)) category = "cleaner_done";
      else if (RE_DELETE.test(msg))       category = "delete";
      else if (RE_RETENTION.test(msg))    category = "retention";
      else if (RE_THRESHOLD.test(msg))    category = "threshold";
      else if (RE_SPACE_INFO.test(msg))   category = "space_info";

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
    return `No storage events found in ${paths.length} file(s).`;
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const out: string[] = [];

  if (mode === "summary") {
    const byCat = new Map<string, number>();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

    out.push(`Storage Summary — ${events.length} events across ${paths.length} file(s)`);
    out.push("");

    const labels: Record<string, string> = {
      disk_full: "Disk full events",
      disk_warning: "Disk space warnings",
      cleaner_start: "Cleaner runs started",
      cleaner_done: "Cleaner runs completed",
      delete: "File deletions",
      retention: "Retention events",
      threshold: "Threshold events",
      space_info: "Space info entries",
    };

    for (const [cat, label] of Object.entries(labels)) {
      const count = byCat.get(cat) ?? 0;
      if (count > 0) {
        const indicator = (cat === "disk_full" || cat === "disk_warning") ? "⚠" : " ";
        out.push(`  ${indicator} ${label.padEnd(24)} ${count}`);
      }
    }

    // Show critical events
    const critical = events.filter(e => e.category === "disk_full" || e.category === "disk_warning");
    if (critical.length > 0) {
      out.push("");
      out.push(`Disk alerts (last ${Math.min(5, critical.length)}):`);
      for (const e of critical.slice(-5)) {
        out.push(`  [${e.timestamp}] ${e.source}: ${e.message.slice(0, 140)}`);
      }
    }

    // Cleaner cycle stats
    const starts = events.filter(e => e.category === "cleaner_start");
    const ends = events.filter(e => e.category === "cleaner_done");
    if (starts.length > 0 || ends.length > 0) {
      out.push("");
      out.push(`Cleaner cycles: ${starts.length} started, ${ends.length} completed`);
    }

  } else if (mode === "events") {
    out.push(`Storage Events — ${events.length} total (showing ${Math.min(limit, events.length)}):`);
    out.push("");
    for (const e of events.slice(0, limit)) {
      const tag = e.category.replace("_", " ").padEnd(16);
      out.push(`[${e.timestamp}] ${tag} <${e.level.padEnd(9)}> ${e.source}: ${e.message.slice(0, 140)}`);
    }
    if (events.length > limit) out.push(`\n… ${events.length - limit} more events`);

  } else if (mode === "timeline") {
    // Hourly buckets showing storage activity trends
    const hourBuckets = new Map<string, { deletes: number; warnings: number; cleanerRuns: number }>();
    for (const e of events) {
      const hour = e.timestamp.slice(0, 2) + ":00";
      const b = hourBuckets.get(hour) ?? { deletes: 0, warnings: 0, cleanerRuns: 0 };
      if (e.category === "delete") b.deletes++;
      if (e.category === "disk_warning" || e.category === "disk_full") b.warnings++;
      if (e.category === "cleaner_start") b.cleanerRuns++;
      hourBuckets.set(hour, b);
    }

    const sorted = [...hourBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxDel = Math.max(1, ...sorted.map(([, b]) => b.deletes));
    const BAR = 20;

    out.push(`Storage Timeline (hourly):`);
    out.push("");
    out.push(`${"Hour".padEnd(6)} ${"Deletions".padEnd(BAR + 2)} ${"Warns".padStart(6)} ${"Cycles".padStart(7)}`);
    out.push("─".repeat(45));
    for (const [hour, b] of sorted) {
      const bar = b.deletes > 0 ? "█".repeat(Math.max(1, Math.round((b.deletes / maxDel) * BAR))) : "";
      const warns = b.warnings > 0 ? `⚠ ${b.warnings}` : "";
      out.push(`${hour.padEnd(6)} ${bar.padEnd(BAR + 2)} ${warns.padStart(6)} ${String(b.cleanerRuns).padStart(7)}`);
    }
  }

  return out.join("\n");
}
