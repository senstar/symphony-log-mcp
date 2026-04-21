/**
 * event-log.ts
 *
 * Parses the Windows Event Log text exports (EventLogApplication.txt,
 * EventLogSystem.txt) captured by LogPackage.cs in each server zip.
 *
 * These logs are invaluable for diagnosing service crashes, driver failures,
 * disk errors, and .NET runtime exceptions that occur outside of Symphony's
 * own log files.
 */

import type { BugReport } from "../lib/bug-report.js";
import * as fs from "fs/promises";
import * as path from "path";
import {
  parseEventLogTxt,
  readFileOrNull,
  type EventLogEntry,
} from "../lib/system-info-parser.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EventLogArgs {
  /**
   * Which log to inspect.
   *   "application" — EventLogApplication.txt
   *   "system"      — EventLogSystem.txt
   *   "both"        — merge both logs and sort by time
   */
  log: "application" | "system" | "both";

  /**
   * Filter by event level. Accepts comma-separated list:
   *   "error", "warning", "critical", "information"
   */
  level?: string;

  /** Filter by event source (substring match, case-insensitive). */
  source?: string;

  /** Filter by event ID. */
  eventId?: number;

  /** Text search in event messages (case-insensitive). */
  search?: string;

  /** Max entries to return (default 50). */
  limit?: number;

  /** "summary" returns a breakdown by source and level instead of entries. */
  mode?: "entries" | "summary";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function toolEventLog(
  bugReport: BugReport | null,
  args: EventLogArgs,
  dirs?: string | string[],
): Promise<string> {
  if (!bugReport && dirs) {
    // Non-bug-report fallback: search directory tree for event log files
    const files = await discoverEventLogFiles(dirs);
    if (!files.app && !files.sys) {
      return "No Windows Event Log exports (EventLogApplication.txt, EventLogSystem.txt) found in the log directory tree. " +
             "These files are typically present only in bug report server zips.";
    }
    return renderEventLogFromFiles(files, args);
  }
  if (!bugReport) {
    return "Event logs require a bug report package or a log directory containing event log exports.";
  }

  const servers = bugReport.servers.filter(s => !s.isClient && s.extras);
  if (servers.length === 0) {
    return "No server data with supplementary files found in this bug report.";
  }

  const limit = args.limit ?? 50;
  const mode = args.mode ?? "entries";
  const out: string[] = [];

  for (const srv of servers) {
    const extras = srv.extras!;
    const entries: EventLogEntry[] = [];

    // Load requested log(s)
    if (args.log === "application" || args.log === "both") {
      const text = await readFileOrNull(extras.eventLogAppTxt);
      if (text) {
        const parsed = parseEventLogTxt(text);
        for (const e of parsed) e.source = e.source || "(Application)";
        entries.push(...parsed);
      }
    }
    if (args.log === "system" || args.log === "both") {
      const text = await readFileOrNull(extras.eventLogSysTxt);
      if (text) {
        const parsed = parseEventLogTxt(text);
        for (const e of parsed) e.source = e.source || "(System)";
        entries.push(...parsed);
      }
    }

    if (entries.length === 0) {
      out.push(`${srv.label}: event log file(s) not available`);
      continue;
    }

    // Apply filters
    let filtered = entries;

    if (args.level) {
      const levels = new Set(args.level.toLowerCase().split(",").map(l => l.trim()));
      filtered = filtered.filter(e => levels.has(e.level.toLowerCase()));
    }

    if (args.source) {
      const src = args.source.toLowerCase();
      filtered = filtered.filter(e => e.source.toLowerCase().includes(src));
    }

    if (args.eventId !== undefined) {
      filtered = filtered.filter(e => e.eventId === args.eventId);
    }

    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter(e => e.message.toLowerCase().includes(s));
    }

    // Sort by date descending (most recent first)
    filtered.sort((a, b) => {
      if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
      return 0;
    });

    if (mode === "summary") {
      out.push(renderSummary(srv.label, filtered));
    } else {
      out.push(renderEntries(srv.label, filtered, limit));
    }
  }

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderSummary(label: string, entries: EventLogEntry[]): string {
  const lines: string[] = [];

  // Count by level
  const byLevel = new Map<string, number>();
  const bySource = new Map<string, Map<string, number>>();

  for (const e of entries) {
    byLevel.set(e.level, (byLevel.get(e.level) ?? 0) + 1);

    if (!bySource.has(e.source)) bySource.set(e.source, new Map());
    const srcMap = bySource.get(e.source)!;
    srcMap.set(e.level, (srcMap.get(e.level) ?? 0) + 1);
  }

  lines.push(`\n═══ ${label} — ${entries.length} event(s) ═══\n`);

  // Level breakdown
  lines.push("  By Level:");
  for (const [level, count] of [...byLevel.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${level.padEnd(15)} ${count}`);
  }

  // Source breakdown — show top 20 sources with their level breakdown
  lines.push("\n  By Source (top 20):");
  const sourceEntries = [...bySource.entries()]
    .map(([src, levels]) => ({
      source: src,
      total: [...levels.values()].reduce((a, b) => a + b, 0),
      errors: (levels.get("Error") ?? 0) + (levels.get("Critical") ?? 0),
      levels,
    }))
    .sort((a, b) => b.errors - a.errors || b.total - a.total)
    .slice(0, 20);

  for (const src of sourceEntries) {
    const lvls = [...src.levels.entries()].map(([l, c]) => `${l}=${c}`).join(", ");
    lines.push(`    ${src.source.padEnd(40)} ${String(src.total).padStart(5)}  (${lvls})`);
  }

  return lines.join("\n");
}

function renderEntries(label: string, entries: EventLogEntry[], limit: number): string {
  const lines: string[] = [];
  lines.push(`\n═══ ${label} — ${entries.length} event(s) (showing ${Math.min(entries.length, limit)}) ═══\n`);

  const display = entries.slice(0, limit);
  for (const e of display) {
    lines.push(`  [${e.level}] ${e.timestamp}  Source: ${e.source}  EventID: ${e.eventId}`);
    // First 3 lines of message as preview
    const msgLines = e.message.split(/\r?\n/).filter(l => l.trim());
    const preview = msgLines.slice(0, 3);
    for (const ml of preview) {
      lines.push(`    ${ml.substring(0, 120)}`);
    }
    if (msgLines.length > 3) lines.push(`    ... (${msgLines.length - 3} more lines)`);
    lines.push("");
  }

  if (entries.length > limit) {
    lines.push(`  ... and ${entries.length - limit} more events (use limit= to see more)`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-bug-report fallback helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoveredEventLogFiles {
  app: string | null;
  sys: string | null;
}

async function discoverEventLogFiles(dirs: string | string[]): Promise<DiscoveredEventLogFiles> {
  const searchDirs = Array.isArray(dirs) ? dirs : [dirs];
  const result: DiscoveredEventLogFiles = { app: null, sys: null };

  for (const dir of searchDirs) {
    let current = dir;
    for (let depth = 0; depth < 5; depth++) {
      try {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (/^EventLogApplication\.txt$/i.test(entry.name) && !result.app) {
            result.app = path.join(current, entry.name);
          }
          if (/^EventLogSystem\.txt$/i.test(entry.name) && !result.sys) {
            result.sys = path.join(current, entry.name);
          }
        }
        // Check one level of subdirectories
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try {
            const subEntries = await fs.readdir(path.join(current, entry.name), { withFileTypes: true });
            for (const sub of subEntries) {
              if (!sub.isFile()) continue;
              if (/^EventLogApplication\.txt$/i.test(sub.name) && !result.app) {
                result.app = path.join(current, entry.name, sub.name);
              }
              if (/^EventLogSystem\.txt$/i.test(sub.name) && !result.sys) {
                result.sys = path.join(current, entry.name, sub.name);
              }
            }
          } catch { /* skip unreadable subdirs */ }
        }
      } catch { /* skip unreadable dirs */ }
      if (result.app && result.sys) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (result.app && result.sys) break;
  }

  return result;
}

async function renderEventLogFromFiles(
  files: DiscoveredEventLogFiles,
  args: EventLogArgs,
): Promise<string> {
  const entries: EventLogEntry[] = [];
  const limit = args.limit ?? 50;
  const mode = args.mode ?? "entries";

  if ((args.log === "application" || args.log === "both") && files.app) {
    const text = await readFileOrNull(files.app);
    if (text) {
      const parsed = parseEventLogTxt(text);
      for (const e of parsed) e.source = e.source || "(Application)";
      entries.push(...parsed);
    }
  }
  if ((args.log === "system" || args.log === "both") && files.sys) {
    const text = await readFileOrNull(files.sys);
    if (text) {
      const parsed = parseEventLogTxt(text);
      for (const e of parsed) e.source = e.source || "(System)";
      entries.push(...parsed);
    }
  }

  if (entries.length === 0) {
    return "Event log file(s) found but contained no parseable entries.";
  }

  // Apply filters
  let filtered = entries;

  if (args.level) {
    const levels = new Set(args.level.toLowerCase().split(",").map(l => l.trim()));
    filtered = filtered.filter(e => levels.has(e.level.toLowerCase()));
  }
  if (args.source) {
    const src = args.source.toLowerCase();
    filtered = filtered.filter(e => e.source.toLowerCase().includes(src));
  }
  if (args.eventId !== undefined) {
    filtered = filtered.filter(e => e.eventId === args.eventId);
  }
  if (args.search) {
    const s = args.search.toLowerCase();
    filtered = filtered.filter(e => e.message.toLowerCase().includes(s));
  }

  filtered.sort((a, b) => {
    if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
    return 0;
  });

  if (mode === "summary") {
    return renderSummary("Server (from log directory)", filtered);
  }
  return renderEntries("Server (from log directory)", filtered, limit);
}
