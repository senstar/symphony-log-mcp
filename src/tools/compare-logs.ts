/**
 * compare-logs.ts
 *
 * Side-by-side comparison of two Symphony log directories (or bug-report servers).
 *
 * For each included dimension the tool runs both A and B, shows results under
 * labelled banners, and for the 'errors' dimension additionally diffs the
 * fingerprint sets to surface fixed / new / changed patterns.
 *
 * Typical usage:
 *   compare_logs  dirA=/Log/Build133  labelA="Build 133 (broken)"
 *                 dirB=/Log/Build138  labelB="Build 138 (fixed)"
 *                 include=["errors","health","lifecycle","slow"]
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import AdmZip from "adm-zip";
import { computeErrorGroups } from "./search-errors.js";
import { toolGetServiceLifecycle } from "./service-lifecycle.js";
import { toolSearchHttpRequests } from "./search-http-requests.js";

import { toolSummarizeHealth } from "./summarize-health.js";
import { listLogFiles, readRawLines } from "../lib/log-reader.js";

export interface CompareLogsArgs {
  /** Absolute path to the first log directory */
  dirA: string;
  labelA?: string;
  /** Absolute path to the second log directory */
  dirB: string;
  labelB?: string;
  /**
   * Which dimensions to compare.
   * Supported: "errors", "lifecycle", "health", "http", "slow"
   * Default: ["errors", "lifecycle", "health"]
   */
  include?: string[];
  startTimeA?: string;
  endTimeA?: string;
  startTimeB?: string;
  endTimeB?: string;
  limit?: number;
  /** Auto-detect active test windows from IS HTTP request density. */
  detectWindows?: boolean;
  /** Append a heuristic change summary after all sections. */
  summarize?: boolean;
}

function divider(title?: string): string {
  const line = "─".repeat(70);
  return title ? `\n${line}\n  ${title}\n${line}\n` : line;
}

function labeled(label: string, content: string): string {
  return `--- ${label} ---\n${content}\n`;
}

// ── Gap-fix helpers ────────────────────────────────────────────────────────

/**
 * Extract a zip to a deterministic temp directory (cached by zip path hash).
 * Searches for the sub-directory that actually contains Symphony log files.
 */
async function extractZipToTemp(zipPath: string): Promise<string> {
  const hash = crypto.createHash("md5").update(zipPath).digest("hex").slice(0, 8);
  const tempBase = path.join(os.tmpdir(), `symphony-log-${hash}`);
  const sentinel = path.join(tempBase, ".extracted");
  let alreadyExtracted = false;
  try { await fs.access(sentinel); alreadyExtracted = true; } catch { /* not yet */ }
  if (!alreadyExtracted) {
    await fs.mkdir(tempBase, { recursive: true });
    new AdmZip(zipPath).extractAllTo(tempBase, true);
    await fs.writeFile(sentinel, zipPath);
  }
  for (const sub of ["ai_logs", "Log", ""]) {
    const candidate = sub ? path.join(tempBase, sub) : tempBase;
    try {
      const entries = await fs.readdir(candidate) as string[];
      if (entries.some(e => /^(is|sccp|Mo|cs\d*|Tracker)-\d{6}_/i.test(e))) return candidate;
    } catch { /* dir doesn't exist */ }
  }
  return tempBase;
}

/**
 * Scan IS log files to find the actual timestamp range present,
 * optionally annotated with the applied time window.
 */
async function detectDataRange(logDir: string, startTime?: string, endTime?: string): Promise<string> {
  const TS_RE = /^(\d{2}:\d{2}:\d{2})/;
  try {
    const files = await listLogFiles(logDir, { prefix: "is" });
    if (files.length === 0) return "?";
    // listLogFiles sorts newest-first; oldest file is the last element
    const firstLines = await readRawLines(files[files.length - 1].fullPath, 100);
    let dataStart = "";
    for (const line of firstLines) { const m = TS_RE.exec(line); if (m) { dataStart = m[1]; break; } }
    const lastLines = await readRawLines(files[0].fullPath);
    let dataEnd = "";
    for (let i = lastLines.length - 1; i >= 0; i--) { const m = TS_RE.exec(lastLines[i]); if (m) { dataEnd = m[1]; break; } }
    const rangeStr = `${dataStart || "?"} → ${dataEnd || "?"}`;
    if (startTime || endTime) return `${rangeStr}  [window: ${startTime ?? "start"} → ${endTime ?? "end"}]`;
    return rangeStr;
  } catch { return "?"; }
}

/** Parse the active-window line emitted by toolSearchHttpRequests(detectActiveWindow:true). */
function parseActiveWindowBanner(output: string): { startTime: string; endTime: string } | null {
  const m = /Active window detected: (\d{2}:\d{2}:\d{2}) → (\d{2}:\d{2}:\d{2})/.exec(output);
  return m ? { startTime: m[1], endTime: m[2] } : null;
}

/** Read the first HH:MM:SS timestamp found in the first 50 lines of a log file. */
async function getFirstTimestamp(fullPath: string): Promise<string | null> {
  const TS_RE = /^(\d{2}:\d{2}:\d{2})/;
  try {
    const lines = await readRawLines(fullPath, 50);
    for (const line of lines) {
      const m = TS_RE.exec(line);
      if (m) return m[1];
    }
    return null;
  } catch { return null; }
}

function hmsToSec(ts: string): number {
  const [h, m, s] = ts.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * Detect the active test window by analysing IS log file rollover rate.
 *
 * During load tests IS files fill up every 1–3 min so the inter-file gap is
 * small.  During startup / idle / recovery the files are written slowly,
 * leaving large gaps between rollovers.
 *
 * Algorithm:
 *   1. Read the first timestamp of every IS file, sorted by rollover number.
 *   2. Group consecutive files into "clusters" where every gap < gapThresholdSec.
 *   3. Pick the largest cluster (most files) — that cluster is the test run.
 *   4. startTime = first timestamp of that cluster.
 *      endTime   = first timestamp of the file immediately after the cluster
 *                  (the first recovery file), which marks when load stopped.
 *
 * Returns null if no qualifying cluster is found (< minClusterSize files).
 */
async function detectTestWindowFromRolloverRate(
  logDir: string,
  gapThresholdSec = 240,  // 4 minutes — test-load gaps are typically 1–3 min
  minClusterSize  = 5,    // need at least 5 IS files to qualify as a test window
): Promise<{ startTime: string; endTime: string } | null> {
  const allFiles = await listLogFiles(logDir, { prefix: "is" });
  if (allFiles.length < minClusterSize) return null;

  // Sort ascending by rollover number so timestamps are chronological
  allFiles.sort((a, b) => parseInt(a.rollover) - parseInt(b.rollover));

  // Read first timestamp from each IS file
  const entries: { ts: string; tsec: number }[] = [];
  for (const f of allFiles) {
    const ts = await getFirstTimestamp(f.fullPath);
    if (ts) entries.push({ ts, tsec: hmsToSec(ts) });
  }
  if (entries.length < minClusterSize) return null;

  // Gap between consecutive entries (handles midnight rollover)
  const gapSec = (i: number): number => {
    const raw = entries[i].tsec - entries[i - 1].tsec;
    return raw < 0 ? raw + 86400 : raw;
  };

  // Find the largest cluster where every consecutive gap is below the threshold
  let bestStart = 0, bestSize = 1;
  let runStart = 0;
  for (let i = 1; i < entries.length; i++) {
    if (gapSec(i) > gapThresholdSec) {
      const size = i - runStart;
      if (size > bestSize) { bestSize = size; bestStart = runStart; }
      runStart = i;
    }
  }
  // Check the final run
  const finalSize = entries.length - runStart;
  if (finalSize > bestSize) { bestSize = finalSize; bestStart = runStart; }

  if (bestSize < minClusterSize) return null;

  const bestEnd  = bestStart + bestSize - 1;
  const startTime = entries[bestStart].ts;
  // endTime = start of the first recovery file (first file outside the dense window)
  const endTime = bestEnd + 1 < entries.length
    ? entries[bestEnd + 1].ts   // first timestamp of the recovery file
    : entries[bestEnd].ts;      // dense run reaches last file; use its start ts

  return { startTime, endTime };
}

type ErrorGroups = Map<string, { count: number; first: { line: { message: string } } }>;

/** Sum occurrences of error groups whose first-line message contains any keyword. */
function patternCount(groups: ErrorGroups, keywords: string[]): number {
  let total = 0;
  for (const [, g] of groups) {
    const msg = g.first.line.message.toLowerCase();
    if (keywords.some(kw => msg.includes(kw.toLowerCase()))) total += g.count;
  }
  return total;
}

/** Build a heuristic change summary block from error comparison data. */
function buildHeuristicSummary(
  labelA: string, labelB: string,
  countA: number, countB: number,
  groupsA: ErrorGroups, groupsB: ErrorGroups
): string {
  const notes: string[] = [];
  if (countA > 0) {
    const pct = Math.round((countB - countA) / countA * 100);
    if (pct <= -20)     notes.push(`✓ Total errors reduced by ${-pct}%  (${countA} → ${countB})`);
    else if (pct >= 20) notes.push(`✗ Total errors increased by ${pct}%  (${countA} → ${countB})`);
    else notes.push(`~ Total errors roughly unchanged  (${countA} → ${countB},  ${pct >= 0 ? "+" : ""}${pct}%)`);
  }
  const checks: Array<{ label: string; kw: string[]; threshold: number }> = [
    { label: "LprVersion calls",          kw: ["lprversion"],                                       threshold: 0.5  },
    { label: "WallGetPanels errors",       kw: ["wallgetpanels"],                                    threshold: 0.5  },
    { label: "AbortAuthenticate storm",    kw: ["abortauthenticate"],                                threshold: 0.3  },
    { label: '"Unable to invoke" errors',  kw: ["unable to invoke"],                                 threshold: 0.3  },
    { label: "Session cleanup activity",   kw: ["removesession", "removesessionfromdb"],             threshold: -1   },
    { label: "DB / connection errors",     kw: ["dbconnect", "connection refused", "sqlexception"],  threshold: 0.5  },
  ];
  for (const { label, kw, threshold } of checks) {
    const a = patternCount(groupsA, kw);
    const b = patternCount(groupsB, kw);
    if (a === 0 && b === 0) continue;
    const pct = a > 0 ? Math.round((b - a) / a * 100) : 100;
    if (threshold < 0) {
      if (b > a * 1.5 && b > 5) notes.push(`✓ ${label}: ${pct}% increase  (${a} → ${b}) — sessions being cleaned properly`);
    } else {
      if (a > 5 && b < a * threshold) notes.push(`✓ ${label}: ${-pct}% reduction  (${a} → ${b})`);
      else if (b > a * 2 && b > 5)    notes.push(`✗ ${label}: ${pct}% increase  (${a} → ${b})`);
    }
  }
  const fixedPat = [...groupsA.keys()].filter(k => !groupsB.has(k)).length;
  const newPat   = [...groupsB.keys()].filter(k => !groupsA.has(k)).length;
  if (fixedPat > 0) notes.push(`✓ ${fixedPat} unique error pattern(s) fully resolved in ${labelB}`);
  if (newPat > 5)   notes.push(`⚠ ${newPat} new error pattern(s) introduced in ${labelB} — review recommended`);
  else if (newPat > 0) notes.push(`~ ${newPat} new error pattern(s) appeared in ${labelB}`);
  if (notes.length === 0) notes.push("No significant behavioral changes detected.");
  return [divider("CHANGE SUMMARY"), ...notes, ""].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────

export async function toolCompareLogs(
  _logDir: string | string[],       // not used — dirA/dirB are the targets
  args: CompareLogsArgs
): Promise<string> {
  const labelA = args.labelA ?? "A";
  const labelB = args.labelB ?? "B";
  const include = args.include ?? ["errors", "lifecycle", "health"];
  const limit = args.limit ?? 50;

  // ── Zip extraction ─────────────────────────────────────────────────────────
  let dirA = args.dirA.toLowerCase().endsWith(".zip") ? await extractZipToTemp(args.dirA) : args.dirA;
  let dirB = args.dirB.toLowerCase().endsWith(".zip") ? await extractZipToTemp(args.dirB) : args.dirB;

  // ── Active window auto-detection ──────────────────────────────────────────
  let startTimeA = args.startTimeA;
  let endTimeA   = args.endTimeA;
  let startTimeB = args.startTimeB;
  let endTimeB   = args.endTimeB;
  let windowNote = "";
  // Auto-detect by default unless the caller explicitly opts out or has already
  // provided explicit time windows for both sides.
  const shouldDetect = args.detectWindows !== false
    && !(startTimeA && startTimeB);
  if (shouldDetect) {
    // Primary: IS file rollover-rate heuristic.
    // Under test load IS files roll every 1–3 min; under idle/startup/recovery
    // they roll much more slowly.  The largest dense cluster of IS files is the
    // test window.
    const [rollA, rollB] = await Promise.all([
      detectTestWindowFromRolloverRate(dirA),
      detectTestWindowFromRolloverRate(dirB),
    ]);
    if (rollA && !startTimeA) { startTimeA = rollA.startTime; endTimeA = rollA.endTime; }
    if (rollB && !startTimeB) { startTimeB = rollB.startTime; endTimeB = rollB.endTime; }

    // Fallback: HTTP request-density heuristic (used only when rollover-rate
    // detection finds no qualifying cluster, e.g. very short test runs or logs
    // that only contain a single IS file).
    const needHttpA = !startTimeA;
    const needHttpB = !startTimeB;
    if (needHttpA || needHttpB) {
      const [httpA, httpB] = await Promise.all([
        needHttpA
          ? toolSearchHttpRequests(dirA, { files: ["is"], rateBy: "minute", detectActiveWindow: true })
          : Promise.resolve(""),
        needHttpB
          ? toolSearchHttpRequests(dirB, { files: ["is"], rateBy: "minute", detectActiveWindow: true })
          : Promise.resolve(""),
      ]);
      if (needHttpA) {
        const w = parseActiveWindowBanner(httpA);
        if (w) { startTimeA = w.startTime; endTimeA = w.endTime; }
      }
      if (needHttpB) {
        const w = parseActiveWindowBanner(httpB);
        if (w) { startTimeB = w.startTime; endTimeB = w.endTime; }
      }
    }

    const detectedA = startTimeA ? `${startTimeA}–${endTimeA}` : "full log";
    const detectedB = startTimeB ? `${startTimeB}–${endTimeB}` : "full log";
    const methodA   = rollA ? "rollover-rate" : (startTimeA ? "http-density" : "none");
    const methodB   = rollB ? "rollover-rate" : (startTimeB ? "http-density" : "none");
    windowNote = `  Auto-detected windows:  A=${detectedA} [${methodA}]   B=${detectedB} [${methodB}]`;
  }

  // ── Data range scan ───────────────────────────────────────────────────────
  const [rangeA, rangeB] = await Promise.all([
    detectDataRange(dirA, startTimeA, endTimeA),
    detectDataRange(dirB, startTimeB, endTimeB),
  ]);

  const out: string[] = [
    "═".repeat(70),
    `  LOG COMPARISON: ${labelA}  vs  ${labelB}`,
    `  A: ${args.dirA}`,
    `  B: ${args.dirB}`,
    `  Data range  A: ${rangeA}`,
    `  Data range  B: ${rangeB}`,
    ...(windowNote ? [windowNote] : []),
    "═".repeat(70),
    "",
  ];

  // Saved for optional heuristic summary
  let errGrpA: ErrorGroups | null = null;
  let errGrpB: ErrorGroups | null = null;
  let errCntA = 0;
  let errCntB = 0;

  // ── ERRORS ────────────────────────────────────────────────────────────────
  if (include.includes("errors")) {
    out.push(divider("ERRORS"));

    const errorFiles = ["is", "cs", "Tracker"];
    const [resA, resB] = await Promise.all([
      computeErrorGroups(dirA, {
        files: errorFiles,
        deduplicate: true,
        startTime: startTimeA,
        endTime: endTimeA,
      }),
      computeErrorGroups(dirB, {
        files: errorFiles,
        deduplicate: true,
        startTime: startTimeB,
        endTime: endTimeB,
      }),
    ]);

    const countA = [...resA.groups.values()].reduce((s, g) => s + g.count, 0);
    const countB = [...resB.groups.values()].reduce((s, g) => s + g.count, 0);

    // Save for heuristic summary
    errGrpA = resA.groups as ErrorGroups;
    errGrpB = resB.groups as ErrorGroups;
    errCntA = countA;
    errCntB = countB;
    const diff = countB - countA;
    const diffStr = diff > 0 ? `+${diff}` : String(diff);

    out.push(`Error occurrences: ${labelA}=${countA}  ${labelB}=${countB}  (diff: ${diffStr})`);
    out.push(`Unique patterns:   ${labelA}=${resA.groups.size}  ${labelB}=${resB.groups.size}`);
    out.push("");

    // Fingerprint diff
    const keysA = new Set(resA.groups.keys());
    const keysB = new Set(resB.groups.keys());

    const fixed   = [...keysA].filter(k => !keysB.has(k));
    const newErrs = [...keysB].filter(k => !keysA.has(k));
    const changed = [...keysA].filter(k =>
      keysB.has(k) && resA.groups.get(k)!.count !== resB.groups.get(k)!.count
    );

    if (fixed.length > 0) {
      out.push(`✓ FIXED (${fixed.length}) — present in ${labelA} but gone in ${labelB}:`);
      for (const k of fixed.slice(0, 8)) {
        const g = resA.groups.get(k)!;
        out.push(`  ${String(g.count).padStart(5)}×  ${g.first.line.message.slice(0, 70)}`);
      }
      if (fixed.length > 8) out.push(`  … and ${fixed.length - 8} more`);
      out.push("");
    }

    if (newErrs.length > 0) {
      out.push(`✗ NEW (${newErrs.length}) — appeared in ${labelB} but not in ${labelA}:`);
      for (const k of newErrs.slice(0, 8)) {
        const g = resB.groups.get(k)!;
        out.push(`  ${String(g.count).padStart(5)}×  ${g.first.line.message.slice(0, 70)}`);
      }
      if (newErrs.length > 8) out.push(`  … and ${newErrs.length - 8} more`);
      out.push("");
    }

    if (changed.length > 0) {
      out.push(`~ CHANGED (${changed.length}) — count changed between ${labelA} and ${labelB}:`);
      for (const k of changed.slice(0, 8)) {
        const a = resA.groups.get(k)!;
        const b = resB.groups.get(k)!;
        const d = b.count - a.count;
        out.push(
          `  ${String(a.count).padStart(5)}→${String(b.count).padStart(5)}  (${d > 0 ? "+" : ""}${d})  ${a.first.line.message.slice(0, 62)}`
        );
      }
      if (changed.length > 8) out.push(`  … and ${changed.length - 8} more`);
      out.push("");
    }

    if (fixed.length === 0 && newErrs.length === 0 && changed.length === 0 && countA === 0 && countB === 0) {
      out.push("No errors found in either log set.");
      out.push("");
    } else if (fixed.length === 0 && newErrs.length === 0 && changed.length === 0) {
      out.push("Error patterns identical between both logs.");
      out.push("");
    }
  }

  // ── HEALTH ────────────────────────────────────────────────────────────────
  if (include.includes("health")) {
    out.push(divider("PROCESS HEALTH"));

    const [resA, resB] = await Promise.all([
      toolSummarizeHealth(dirA, {
        sccpFiles:  ["sccp"],
        errorFiles: ["is"],
        startTime:  startTimeA,
        endTime:    endTimeA,
      }),
      toolSummarizeHealth(dirB, {
        sccpFiles:  ["sccp"],
        errorFiles: ["is"],
        startTime:  startTimeB,
        endTime:    endTimeB,
      }),
    ]);

    out.push(labeled(labelA, resA));
    out.push(labeled(labelB, resB));
  }

  // ── LIFECYCLE ─────────────────────────────────────────────────────────────
  if (include.includes("lifecycle")) {
    out.push(divider("SERVICE LIFECYCLE"));

    const lifecycleFiles = ["is", "cs", "Tracker", "Mo", "sccp"];
    const [resA, resB] = await Promise.all([
      toolGetServiceLifecycle(dirA, {
        files:     lifecycleFiles,
        startTime: startTimeA,
        endTime:   endTimeA,
      }),
      toolGetServiceLifecycle(dirB, {
        files:     lifecycleFiles,
        startTime: startTimeB,
        endTime:   endTimeB,
      }),
    ]);

    out.push(labeled(labelA, resA));
    out.push(labeled(labelB, resB));
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  if (include.includes("http")) {
    out.push(divider("HTTP REQUESTS (rate by hour)"));

    const [resA, resB] = await Promise.all([
      toolSearchHttpRequests(dirA, {
        files:     ["is"],
        rateBy:    "hour",
        startTime: startTimeA,
        endTime:   endTimeA,
      }),
      toolSearchHttpRequests(dirB, {
        files:     ["is"],
        rateBy:    "hour",
        startTime: startTimeB,
        endTime:   endTimeB,
      }),
    ]);

    out.push(labeled(labelA, resA));
    out.push(labeled(labelB, resB));
  }

  // ── SLOW ──────────────────────────────────────────────────────────────────
  if (include.includes("slow")) {
    out.push(divider("SLOW REQUESTS (grouped by method)"));

    const [resA, resB] = await Promise.all([
      toolSearchHttpRequests(dirA, {
        files:       ["is", "Mo", "cs", "Tracker"],
        mode:        "slow",
        thresholdMs: 1000,
        slowGroupBy: "request",
        includeRpc:  true,
        limit,
        startTime:   startTimeA,
        endTime:     endTimeA,
      }),
      toolSearchHttpRequests(dirB, {
        files:       ["is", "Mo", "cs", "Tracker"],
        mode:        "slow",
        thresholdMs: 1000,
        slowGroupBy: "request",
        includeRpc:  true,
        limit,
        startTime:   startTimeB,
        endTime:     endTimeB,
      }),
    ]);

    out.push(labeled(labelA, resA));
    out.push(labeled(labelB, resB));
  }

  // ── HEURISTIC CHANGE SUMMARY ─────────────────────────────────────────────
  if (args.summarize && errGrpA && errGrpB) {
    out.push(buildHeuristicSummary(labelA, labelB, errCntA, errCntB, errGrpA, errGrpB));
  }

  return out.join("\n");
}
