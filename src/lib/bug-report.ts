/**
 * bug-report.ts
 *
 * Support for Symphony "bug report" packages — folders produced by the
 * Help → Submit Bug Report feature.
 *
 * Layout of a bug report folder:
 *   bugreport.txt                              — customer / incident metadata
 *   serverinfo.txt                             — per-server hardware/topology info
 *   SymphonyLog-{IP}-{YYMMDD}-{HHMMSS}.zip    — one per selected server
 *   SymphonyLog-client-{YYMMDD}-{HHMMSS}.zip  — client logs (no standard log files)
 *
 * Inside each server zip the parseable logs live under ai_logs/:
 *   ai_logs/is-260128_00.txt
 *   ai_logs/Mo-260128_00.txt
 *   ai_logs/pd-260128_00.txt
 *   ai_logs/sc-260128_00.txt
 *   ai_logs/sccp-260128_00.txt
 *   ai_logs/hm-260128_{N}.txt   (many rollovers)
 *   ai_logs/cs{N}-260128_00.txt (one per camera)
 *   …
 *
 * On first use the relevant files are extracted to a per-bug-report temp
 * directory so the rest of the tool infrastructure can work with plain paths.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import AdmZip from "adm-zip";
import { parseLogFilename } from "./log-reader.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerInfo {
  /** Machine name, e.g. "CCTVSRV04" */
  serverName: string;
  /** IP address from the zip filename, e.g. "10.60.31.4" */
  serverIp: string;
  isMaster: boolean;
  isClient: boolean;
  /** Absolute path to the extracted log directory (empty for client zip) */
  logDir: string;
  /** Human-readable label, e.g. "CCTVSRV04 (10.60.31.4) [Master]" */
  label: string;
}

export interface BugReport {
  folderPath: string;
  productVersion: string;
  farmName: string;
  logStartTime: string;
  logEndTime: string;
  problemDescription: string;
  timeOfError: string;
  servers: ServerInfo[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_ZIP_RE = /^SymphonyLog-(.+)-\d{6}-\d{6}\.zip$/i;
const CLIENT_ZIP_RE = /^SymphonyLog-client-\d{6}-\d{6}\.zip$/i;

/** Returns true if `dir` looks like a Symphony bug report package. */
export async function isBugReportFolder(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.some(e => SERVER_ZIP_RE.test(e) || CLIENT_ZIP_RE.test(e));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing metadata files
// ─────────────────────────────────────────────────────────────────────────────

function parseBugReportTxt(text: string): Partial<BugReport> {
  const get = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "im").exec(text);
    return m ? m[1].trim() : "";
  };
  return {
    productVersion:     get("Product Version"),
    farmName:           get("Farm Name"),
    logStartTime:       get("Log Start Time"),
    logEndTime:         get("Log End Time"),
    problemDescription: get("Problem Description"),
    timeOfError:        get("Time of Error"),
  };
}

/**
 * Parse serverinfo.txt. Returns a map from server IP → { name, isMaster }.
 * The "This Server" lines contain the IP of the machine that produced the block,
 * and "(Master)" appears on the master server's own entry.
 */
function parseServerInfoTxt(text: string): Map<string, { name: string; isMaster: boolean }> {
  const result = new Map<string, { name: string; isMaster: boolean }>();

  // Split on block headers: "--- Server Info (NAME) ---"
  const parts = text.split(/---\s*Server Info\s*\(([^)]+)\)\s*---/i);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    const body = parts[i + 1] ?? "";

    // Find the line that says "(This Server)" to get this machine's IP
    const thisServerLine = /IP:\s*([\d.]+)[^\n]*?\(This Server\)/i.exec(body);
    if (!thisServerLine) continue;

    const ip = thisServerLine[1];
    // Master is noted on the same line or nearby: "(Master)"
    const isMaster = /IP:\s*[\d.]+[^\n]*?\(Master\)[^\n]*?\(This Server\)|IP:\s*[\d.]+[^\n]*?\(This Server\)[^\n]*?\(Master\)/i.test(body);
    result.set(ip, { name, isMaster });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract ai_logs/*.txt files (standard log format only) from a server zip
 * into `dest`. Skips if `dest` already exists (cached extraction).
 */
async function extractServerZip(zipPath: string, extractBase: string): Promise<string> {
  const label = path.basename(zipPath, ".zip");
  const dest = path.join(extractBase, label);

  // Already extracted — reuse
  try {
    await fs.access(dest);
    return dest;
  } catch { /* not yet extracted */ }

  await fs.mkdir(dest, { recursive: true });

  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    // Normalise path separators (zip may use backslash on Windows)
    const entryName = entry.entryName.replace(/\\/g, "/");

    // Only extract files from the ai_logs/ or Log/ subtree (both layouts are used)
    const knownPrefix = entryName.startsWith("ai_logs/") || entryName.startsWith("Log/");
    if (!knownPrefix) continue;

    const filename = path.basename(entryName);

    // Only extract files the log-reader already knows how to parse
    if (!parseLogFilename(filename)) continue;

    await fs.writeFile(path.join(dest, filename), entry.getData());
  }

  return dest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a bug report folder, extract all server log zips (lazily cached in
 * the OS temp directory), and return the fully-resolved BugReport.
 */
export async function extractBugReport(folderPath: string): Promise<BugReport> {
  const files = await fs.readdir(folderPath);

  // --- metadata ---
  let meta: Partial<BugReport> = {};
  let serverInfoMap = new Map<string, { name: string; isMaster: boolean }>();

  try {
    const txt = await fs.readFile(path.join(folderPath, "bugreport.txt"), "utf8");
    meta = parseBugReportTxt(txt);
  } catch { /* optional */ }

  try {
    const txt = await fs.readFile(path.join(folderPath, "serverinfo.txt"), "utf8");
    serverInfoMap = parseServerInfoTxt(txt);
  } catch { /* optional */ }

  // Deterministic temp base dir — safe to reuse across invocations
  const hash = crypto.createHash("sha1").update(folderPath).digest("hex").slice(0, 12);
  const extractBase = path.join(os.tmpdir(), "symphony-mcp", hash);
  await fs.mkdir(extractBase, { recursive: true });

  // --- process each zip ---
  const servers: ServerInfo[] = [];

  for (const file of files) {
    if (CLIENT_ZIP_RE.test(file)) {
      servers.push({
        serverName: "Client",
        serverIp:   "",
        isMaster:   false,
        isClient:   true,
        logDir:     "",
        label:      "Client",
      });
      continue;
    }

    const m = SERVER_ZIP_RE.exec(file);
    if (!m) continue;

    const ip = m[1]; // e.g. "10.60.31.8"
    const zipPath = path.join(folderPath, file);
    const logDir = await extractServerZip(zipPath, extractBase);

    const info = serverInfoMap.get(ip);
    const serverName = info?.name ?? ip;
    const isMaster   = info?.isMaster ?? false;

    servers.push({
      serverName,
      serverIp: ip,
      isMaster,
      isClient: false,
      logDir,
      label: `${serverName} (${ip})${isMaster ? " [Master]" : ""}`,
    });
  }

  // Sort: master first, then alphabetically, client last
  servers.sort((a, b) => {
    if (a.isClient && !b.isClient) return 1;
    if (!a.isClient && b.isClient) return -1;
    if (a.isMaster && !b.isMaster) return -1;
    if (!a.isMaster && b.isMaster) return 1;
    return a.serverName.localeCompare(b.serverName);
  });

  return {
    folderPath,
    productVersion:     meta.productVersion     ?? "",
    farmName:           meta.farmName           ?? "",
    logStartTime:       meta.logStartTime       ?? "",
    logEndTime:         meta.logEndTime         ?? "",
    problemDescription: meta.problemDescription ?? "",
    timeOfError:        meta.timeOfError        ?? "",
    servers,
  };
}
