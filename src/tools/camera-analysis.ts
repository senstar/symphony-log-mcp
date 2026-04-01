/**
 * camera-analysis.ts
 *
 * Camera inventory and status analysis:
 *   - Inventory from cs{N}_vidcaps.txt and tracker log files
 *   - Camera problems: crash-loops, disconnects, URL errors
 *   - Cross-reference with health data
 */

import * as fs from "fs/promises";
import * as path from "path";
import { tryReadLogEntries, resolveFileRefs, listLogFiles, appendWarnings } from "../lib/log-reader.js";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_VIDCAPS     = /^cs(\d+)_vidcaps\.txt$/;
const RE_TRACKER_LOG = /^cs(\d+)-/;
const RE_DISCONNECT  = /disconnect|connection\s+(?:lost|failed|timeout)|RPC\s+Update\s+Connection\s+Failed/i;
const RE_URL_ERROR   = /Problem with URL|Empty profileToken|invalid\s+URI|bad\s+request/i;
const RE_FRAME_DROP  = /frame\s+drop|frames?\s+lost|video\s+loss|no\s+frames/i;
const RE_CONNECTED   = /(?:camera|stream)\s+(?:connect|start|receiving)/i;

interface CameraInfo {
  id: number;
  hasVidcaps: boolean;
  vidcapsContent: string;
  logFileCount: number;
  totalErrors: number;
  disconnects: number;
  urlErrors: number;
  frameDrops: number;
}

export interface CameraArgs {
  mode: "inventory" | "problems" | "status";
  cameraFilter?: string;
  files?: string[];
  limit?: number;
}

export async function toolCameras(
  logDir: string | string[],
  args: CameraArgs,
): Promise<string> {
  const { mode, limit = 50, cameraFilter } = args;
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const cameras = new Map<number, CameraInfo>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch { continue; }

    // Discover vidcaps files
    for (const e of entries) {
      const m = RE_VIDCAPS.exec(e);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      let vidcaps = "";
      try {
        vidcaps = await fs.readFile(path.join(dir, e), "utf8");
      } catch { /* skip */ }

      const cam = cameras.get(id) ?? {
        id, hasVidcaps: false, vidcapsContent: "", logFileCount: 0,
        totalErrors: 0, disconnects: 0, urlErrors: 0, frameDrops: 0,
      };
      cam.hasVidcaps = true;
      cam.vidcapsContent = vidcaps.trim();
      cameras.set(id, cam);
    }

    // Discover tracker log files
    for (const e of entries) {
      const m = RE_TRACKER_LOG.exec(e);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      const cam = cameras.get(id) ?? {
        id, hasVidcaps: false, vidcapsContent: "", logFileCount: 0,
        totalErrors: 0, disconnects: 0, urlErrors: 0, frameDrops: 0,
      };
      cam.logFileCount++;
      cameras.set(id, cam);
    }
  }

  // If cameraFilter provided, parse errors for matching cameras
  const cameraIds = [...cameras.keys()].sort((a, b) => a - b);
  if (cameraFilter) {
    const filterNum = parseInt(cameraFilter, 10);
    if (!isNaN(filterNum)) {
      const filtered = cameraIds.filter(id => id === filterNum);
      if (filtered.length === 0) return `Camera ${cameraFilter} not found.`;
    }
  }

  // For problems/status modes, scan log files for errors
  const cameraWarnings: string[] = [];
  if (mode === "problems" || mode === "status") {
    const allFiles = await listLogFiles(logDir);
    const trackerFiles = allFiles.filter(f => f.prefix.startsWith("cs"));

    // Process files (limit to avoid timeout on huge datasets)
    const filesToScan = trackerFiles.slice(0, 500);
    for (const f of filesToScan) {
      const m = RE_TRACKER_LOG.exec(path.basename(f.fullPath));
      if (!m) continue;
      const id = parseInt(m[1], 10);
      if (cameraFilter && id !== parseInt(cameraFilter, 10)) continue;

      const cam = cameras.get(id);
      if (!cam) continue;

      const entries = await tryReadLogEntries(f.fullPath, cameraWarnings);
      if (entries) {
        for (const entry of entries) {
          if (entry.line.level === "Error") {
            cam.totalErrors++;
            const msg = entry.line.message;
            if (RE_DISCONNECT.test(msg)) cam.disconnects++;
            if (RE_URL_ERROR.test(msg)) cam.urlErrors++;
            if (RE_FRAME_DROP.test(msg)) cam.frameDrops++;
          }
        }
      }
    }
  }

  if (cameras.size === 0) return appendWarnings("No cameras found in the log directory.", cameraWarnings);

  switch (mode) {
    case "inventory":
      return appendWarnings(formatInventory(cameras, limit), cameraWarnings);
    case "problems":
      return appendWarnings(formatProblems(cameras, limit), cameraWarnings);
    case "status":
      return appendWarnings(formatStatus(cameras, limit), cameraWarnings);
    default:
      return `Unknown mode '${mode}'. Use: inventory, problems, status`;
  }
}

function formatInventory(cameras: Map<number, CameraInfo>, limit: number): string {
  const out: string[] = [];
  const sorted = [...cameras.values()].sort((a, b) => a.id - b.id);
  out.push("═".repeat(60));
  out.push(`  CAMERA INVENTORY (${sorted.length} cameras)`);
  out.push("═".repeat(60));
  out.push("");

  // Range summary
  if (sorted.length > 0) {
    const minId = sorted[0].id;
    const maxId = sorted[sorted.length - 1].id;
    out.push(`  ID Range: ${minId} – ${maxId}`);
    out.push(`  With vidcaps: ${sorted.filter(c => c.hasVidcaps).length}`);
    out.push(`  With log files: ${sorted.filter(c => c.logFileCount > 0).length}`);
    out.push("");
  }

  // Show cameras with vidcaps info
  const withVidcaps = sorted.filter(c => c.hasVidcaps && c.vidcapsContent).slice(0, limit);
  if (withVidcaps.length > 0) {
    out.push("Camera Capabilities:");
    out.push("─".repeat(60));
    for (const c of withVidcaps) {
      out.push(`  Camera ${c.id}: ${c.vidcapsContent.slice(0, 100)}`);
    }
  }

  out.push("═".repeat(60));
  return out.join("\n");
}

function formatProblems(cameras: Map<number, CameraInfo>, limit: number): string {
  const out: string[] = [];
  const problems = [...cameras.values()]
    .filter(c => c.totalErrors > 0)
    .sort((a, b) => b.totalErrors - a.totalErrors)
    .slice(0, limit);

  out.push("═".repeat(70));
  out.push(`  CAMERA PROBLEMS (${problems.length} cameras with errors)`);
  out.push("═".repeat(70));
  out.push("");

  if (problems.length === 0) {
    out.push("  No camera errors found.");
    return out.join("\n");
  }

  out.push(`${"Camera".padEnd(12)} ${"Errors".padStart(6)} ${"Disconn".padStart(8)} ${"URL Err".padStart(8)} ${"FrmDrop".padStart(8)} ${"LogFiles".padStart(8)}`);
  out.push("─".repeat(70));

  for (const c of problems) {
    const icon = c.totalErrors > 100 ? "✗" : c.totalErrors > 10 ? "~" : "·";
    out.push(
      `${(icon + " cs" + c.id).padEnd(12)} ${String(c.totalErrors).padStart(6)} ${String(c.disconnects).padStart(8)} ${String(c.urlErrors).padStart(8)} ${String(c.frameDrops).padStart(8)} ${String(c.logFileCount).padStart(8)}`
    );
  }

  out.push("═".repeat(70));
  return out.join("\n");
}

function formatStatus(cameras: Map<number, CameraInfo>, limit: number): string {
  const sorted = [...cameras.values()].sort((a, b) => a.id - b.id).slice(0, limit);
  const out: string[] = [];

  out.push("═".repeat(60));
  out.push(`  CAMERA STATUS (${cameras.size} cameras)`);
  out.push("═".repeat(60));
  out.push("");

  const healthy = sorted.filter(c => c.totalErrors === 0);
  const unhealthy = sorted.filter(c => c.totalErrors > 0);

  if (unhealthy.length > 0) {
    out.push(`UNHEALTHY (${unhealthy.length}):`);
    for (const c of unhealthy.slice(0, 30)) {
      out.push(`  ✗ Camera ${c.id}: ${c.totalErrors} errors (${c.disconnects} disconnects, ${c.urlErrors} URL errors)`);
    }
    if (unhealthy.length > 30) out.push(`  ... and ${unhealthy.length - 30} more`);
    out.push("");
  }

  out.push(`HEALTHY (${healthy.length}): ${healthy.length > 10 ? `cs${healthy[0]?.id ?? "?"} – cs${healthy[healthy.length - 1]?.id ?? "?"}` : healthy.map(c => `cs${c.id}`).join(", ")}`);

  out.push("═".repeat(60));
  return out.join("\n");
}
