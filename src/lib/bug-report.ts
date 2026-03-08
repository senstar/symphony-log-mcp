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
  /**
   * Paths to supplementary (non-log) files extracted from the server zip.
   * All fields are undefined when running in plain log-directory mode.
   */
  extras?: ServerExtras;
}

/**
 * Paths to the supplementary diagnostic files extracted from a server zip.
 * Each field is the absolute path to the extracted file, or undefined if
 * the file was not present in the zip.
 */
export interface ServerExtras {
  // ── System information (all run via Utils.ExecuteCommand with 5-second timeout) ──
  servicesTxt?:       string;  // sc.exe queryex → stdout
  tasklistTxt?:       string;  // tasklist.exe /V → stdout
  ipconfigTxt?:       string;  // ipconfig.exe /all → stdout
  netstatTxt?:        string;  // netstat.exe -nao → file, then netstat.exe -r → append
  systeminfoTxt?:     string;  // systeminfo.exe → stdout (often truncated — 5s timeout too short)
  environmentTxt?:    string;  // cmd.exe /c set → stdout
  printshmemTxt?:     string;  // printshmem.exe x2 → stdout (custom tool from BinaryDir)

  // ── Event logs (custom tool: _Tools/EventViewerConsole.exe "<Log> <Days>") ──
  eventLogAppTxt?:    string;  // EventViewerConsole.exe "Application 14" — last 14 days
  eventLogSysTxt?:    string;  // EventViewerConsole.exe "System 14" — last 14 days

  // ── License / install ──
  licenseReg?:        string;  // DEAD CODE in LogPackage.cs — path is defined but file is never created
  licenseTxt?:        string;  // LicensingStatus.WriteReport() — multi-section report
  dirTxt?:            string;  // GenerateFileList() — custom format: size yyyy/MM/dd HH:mm:ss version path

  // ── Database tables (from LogPackageDAL, uses DataTable.WriteTable() format) ──
  dbTxt?:             string;  // DataTable with columns "Tbl", "Count" — all user tables
  tableSettingsXml?:  string;  // XmlSerializer(CSetting[]) — full Settings table from DB

  // ── All Table*.txt / View*.txt files ──
  tableFiles?:        string[];  // paths to every Table*.txt / View*.txt
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
 * Supplementary (non-log) files we want to extract from server zips.
 * Maps zip-internal filename (case-insensitive) to the ServerExtras key.
 */
const EXTRA_FILES: Record<string, keyof ServerExtras> = {
  "services.txt":             "servicesTxt",
  "tasklist.txt":             "tasklistTxt",
  "ipconfig.txt":             "ipconfigTxt",
  "netstat.txt":              "netstatTxt",
  "systeminfo.txt":           "systeminfoTxt",
  "environment.txt":          "environmentTxt",
  "printshmem.txt":           "printshmemTxt",
  "eventlogapplication.txt":  "eventLogAppTxt",
  "eventlogsystem.txt":       "eventLogSysTxt",
  "license.reg":              "licenseReg",
  "license.txt":              "licenseTxt",
  "dir.txt":                  "dirTxt",
  "db.txt":                   "dbTxt",
  "tablesettings.xml":        "tableSettingsXml",
};

/**
 * Extract log files AND supplementary diagnostic files from a server zip
 * into `dest`. Skips if `dest` already exists (cached extraction).
 * Returns { logDir, extras }.
 */
async function extractServerZip(
  zipPath: string,
  extractBase: string,
): Promise<{ logDir: string; extras: ServerExtras }> {
  const label = path.basename(zipPath, ".zip");
  const dest = path.join(extractBase, label);
  const extrasDir = path.join(dest, "_extras");

  // Already extracted — rebuild extras from what's on disk
  try {
    await fs.access(dest);
    const extras = await rebuildExtrasFromDisk(extrasDir);
    return { logDir: dest, extras };
  } catch { /* not yet extracted */ }

  await fs.mkdir(dest, { recursive: true });
  await fs.mkdir(extrasDir, { recursive: true });

  const extras: ServerExtras = {};
  const tableFiles: string[] = [];

  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    // Normalise path separators (zip may use backslash on Windows)
    const entryName = entry.entryName.replace(/\\/g, "/");
    const filename = path.basename(entryName);

    // ── Log files: from ai_logs/ or Log/ subtrees ──
    const isLogSubtree = entryName.startsWith("ai_logs/") || entryName.startsWith("Log/");
    if (isLogSubtree && parseLogFilename(filename)) {
      await fs.writeFile(path.join(dest, filename), entry.getData());
      continue;
    }

    // ── Supplementary files: extract to _extras/ ──
    const lowerName = filename.toLowerCase();

    // Named extras (services.txt, netstat.txt, etc.)
    const extraKey = EXTRA_FILES[lowerName];
    if (extraKey) {
      const outPath = path.join(extrasDir, filename);
      await fs.writeFile(outPath, entry.getData());
      (extras as Record<string, string>)[extraKey] = outPath;
      continue;
    }

    // Table*.txt / View*.txt files (there are ~20+ of these)
    if (/^(Table|View)[A-Za-z]+\.(txt|xml)$/i.test(filename)) {
      const outPath = path.join(extrasDir, filename);
      await fs.writeFile(outPath, entry.getData());
      tableFiles.push(outPath);
      continue;
    }

    // Log files at root level (some zips don't use ai_logs/ prefix)
    if (parseLogFilename(filename)) {
      await fs.writeFile(path.join(dest, filename), entry.getData());
    }
  }

  if (tableFiles.length > 0) {
    extras.tableFiles = tableFiles.sort();
  }

  // Persist extras manifest so we can rebuild on cache hit
  await fs.writeFile(
    path.join(extrasDir, "_manifest.json"),
    JSON.stringify(extras, null, 2),
  );

  return { logDir: dest, extras };
}

/**
 * Rebuild ServerExtras from a previously-extracted _extras directory.
 */
async function rebuildExtrasFromDisk(extrasDir: string): Promise<ServerExtras> {
  try {
    const manifest = await fs.readFile(path.join(extrasDir, "_manifest.json"), "utf8");
    return JSON.parse(manifest) as ServerExtras;
  } catch {
    return {};
  }
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
    const { logDir, extras } = await extractServerZip(zipPath, extractBase);

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
      extras,
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
