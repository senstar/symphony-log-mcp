import * as fs from "fs/promises";
import { createReadStream } from "fs";
import * as readline from "readline";
import type { Dirent } from "fs";
import * as path from "path";
import { parseLogEntries, parseLogLine, type LogEntry, type LogLine } from "./log-parser.js";

export interface LogFileInfo {
  filename: string;
  fullPath: string;
  prefix: string;
  date: string; // YYMMDD
  rollover: string; // zero-padded number
  sizeBytes: number;
  modifiedAt: Date;
  /** Set when files are gathered from a bug-report package (server label) */
  serverLabel?: string;
}

/** Parse filename like "is-260302_00.txt" */
export function parseLogFilename(filename: string): Omit<LogFileInfo, "fullPath" | "sizeBytes" | "modifiedAt"> | null {
  const m = /^([a-zA-Z0-9_]+)-(\d{6})_(\d+)\.txt$/i.exec(filename);
  if (!m) return null;
  return {
    filename,
    prefix: m[1].toLowerCase(),
    date: m[2],
    rollover: m[3],
  };
}

/** List all Symphony log files in one directory, optionally filtered */
async function listLogFilesInDir(
  logDir: string,
  opts: { prefix?: string; date?: string },
  serverLabel?: string,
): Promise<LogFileInfo[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot list directory: ${logDir}`);
  }

  const files: LogFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseLogFilename(entry.name);
    if (!parsed) continue;
    if (opts.prefix && !parsed.prefix.startsWith(opts.prefix.toLowerCase())) continue;
    if (opts.date && parsed.date !== opts.date) continue;

    const fullPath = path.join(logDir, entry.name);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    files.push({
      ...parsed,
      fullPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      serverLabel,
    });
  }
  return files;
}

/**
 * List all Symphony log files in one or more directories, optionally filtered.
 * When multiple directories are provided (bug-report mode), each file is tagged
 * with its `serverLabel` so callers can show which server it came from.
 */
export async function listLogFiles(
  logDir: string | string[],
  opts: {
    prefix?: string;
    date?: string;
    limit?: number;
    /** Labels corresponding to each dir in logDir (when logDir is an array) */
    serverLabels?: string[];
  } = {}
): Promise<LogFileInfo[]> {
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const labels = opts.serverLabels ?? [];

  const allFiles: LogFileInfo[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const label = labels[i]; // undefined if not in bug-report mode
    const batch = await listLogFilesInDir(dirs[i], opts, label);
    allFiles.push(...batch);
  }

  // Sort by date desc, rollover desc (numeric), then prefix asc so single-rollover
  // files (Mo, pd, sccp, hm …) aren't buried below high-rollover is-* files.
  allFiles.sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    const rollCmp = parseInt(b.rollover, 10) - parseInt(a.rollover, 10);
    if (rollCmp !== 0) return rollCmp;
    return a.prefix.localeCompare(b.prefix);
  });

  if (opts.limit) return allFiles.slice(0, opts.limit);
  return allFiles;
}

const MAX_LINES_LIMIT = 10_000;

/** Read raw lines from a log file, with optional BOM stripping */
export async function readRawLines(
  fullPath: string,
  maxLines?: number
): Promise<string[]> {
  if (maxLines !== undefined) {
    maxLines = Math.min(maxLines, MAX_LINES_LIMIT);
  } else {
    maxLines = MAX_LINES_LIMIT;
  }
  let content = await fs.readFile(fullPath, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const lines = content.split(/\r?\n/);
  return lines.slice(0, maxLines);
}

/** Validate HH:MM:SS time format. Throws on invalid format. */
export function validateTimeFormat(time: string | undefined, paramName: string): void {
  if (time === undefined) return;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid ${paramName}: "${time}" — expected HH:MM:SS format (e.g., "14:30:00")`);
  }
}

/**
 * Read raw lines from a log file with optional time-window filtering.
 * Lines whose leading timestamp (HH:MM:SS) falls outside [startTime, endTime]
 * are excluded. Non-timestamped lines (continuations) are included only if the
 * preceding timestamped line was in-window.
 */
export async function readRawLinesWithTimeFilter(
  fullPath: string,
  startTime?: string,
  endTime?: string,
): Promise<string[]> {
  validateTimeFormat(startTime, "startTime");
  validateTimeFormat(endTime, "endTime");
  const allLines = await readRawLines(fullPath);
  if (!startTime && !endTime) return allLines;

  const result: string[] = [];
  let inWindow = true;
  const RE_TS = /^(\d{2}:\d{2}:\d{2})/;

  for (const line of allLines) {
    const tsMatch = RE_TS.exec(line);
    if (tsMatch) {
      inWindow = isInTimeWindow(tsMatch[1], startTime, endTime);
    }
    if (inWindow) result.push(line);
  }
  return result;
}

/** Read and parse a log file into LogEntry objects */
export async function readLogEntries(
  fullPath: string,
  maxLines?: number
): Promise<LogEntry[]> {
  const lines = await readRawLines(fullPath, maxLines);
  return parseLogEntries(lines);
}

/** Resolve a log file path — accepts full path or filename within logDir */
export function resolveLogPath(fileRef: string, logDir: string | string[]): string {
  if (path.isAbsolute(fileRef)) return fileRef;
  const dir = Array.isArray(logDir) ? logDir[0] : logDir;
  return path.join(dir, fileRef);
}

/**
 * Expand a list of file refs to absolute paths.
 * Accepts:
 *   - exact filenames:      "is-260227_31.txt"
 *   - prefix only:          "is"  → all is-*.txt in logDir
 *   - prefix+date:          "is-260227" → is-260227_*.txt
 * When logDir is an array (bug-report mode) the search covers all directories.
 * Deduplicates and preserves order.
 */
export async function resolveFileRefs(fileRefs: string[], logDir: string | string[]): Promise<string[]> {
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const result: string[] = [];
  // Cache the directory listing so we only read once across multiple refs
  let cachedFiles: LogFileInfo[] | null = null;
  const getFiles = async () => {
    if (!cachedFiles) cachedFiles = await listLogFiles(dirs);
    return cachedFiles;
  };

  for (let ref of fileRefs) {
    ref = ref.trim();
    if (!ref) continue;
    if (path.isAbsolute(ref)) {
      result.push(ref);
      continue;
    }
    // Exact filename recognised by the rollover suffix pattern — search all dirs
    if (/^[a-zA-Z0-9_]+-\d{6}_\d+\.txt$/i.test(ref)) {
      for (const dir of dirs) {
        const candidate = path.join(dir, ref);
        try {
          await fs.access(candidate);
          result.push(candidate);
        } catch { /* not in this dir */ }
      }
      continue;
    }
    // Prefix-based expansion. Three forms accepted:
    //   "is"            → exact prefix match (f.prefix === "is")   — does NOT match isac
    //   "is-260227"     → prefix + date exact match
    //   "is-260227_31"  → already handled above by the filename regex
    const lower = ref.toLowerCase().replace(/[-_]$/, "");
    const all = await getFiles();
    for (const f of all) {
      const keyNoRoll = `${f.prefix}-${f.date}`;  // e.g. "is-260227"
      const keyFull   = `${f.prefix}-${f.date}_${f.rollover}`; // e.g. "is-260227_31"
      if (
        f.prefix === lower ||        // exact prefix:      "is" → is-*
        keyNoRoll === lower ||        // prefix+date:       "is-260227" → is-260227_*
        keyFull   === lower           // full key no ext:   "is-260227_31"
      ) {
        result.push(f.fullPath);
      }
    }
  }

  // Deduplicate preserving order
  return [...new Set(result)];
}

/** Return true if a log timestamp (HH:MM:SS.mmm) falls within [startTime, endTime] (HH:MM:SS) */
export function isInTimeWindow(timestamp: string, startTime?: string, endTime?: string): boolean {
  if (!startTime && !endTime) return true;
  const t = timestamp.slice(0, 8); // HH:MM:SS
  if (startTime && endTime && startTime > endTime) {
    // Midnight-spanning window (e.g. 23:00–01:00): match if at-or-after start OR at-or-before end
    return t >= startTime || t <= endTime;
  }
  if (startTime && t < startTime) return false;
  if (endTime && t > endTime) return false;
  return true;
}

/**
 * Stream-based log reader using Node readline.
 * Processes a log file line-by-line without loading the entire file into memory.
 * Calls `onEntry` for each parsed LogEntry as it's constructed.
 * Returns total number of entries processed.
 */
export async function streamLogEntries(
  fullPath: string,
  onEntry: (entry: LogEntry) => void | boolean, // return false to stop early
  opts?: {
    startTime?: string;
    endTime?: string;
    maxEntries?: number;
  }
): Promise<number> {
  const { startTime, endTime, maxEntries } = opts ?? {};

  return new Promise((resolve, reject) => {
    const stream = createReadStream(fullPath, { encoding: "utf8" });
    stream.on("error", (err) => {
      reject(err);
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let currentEntry: LogEntry | null = null;
    let count = 0;
    let stopped = false;
    let firstChar = true;
    let lineNum = 0;

    const flush = () => {
      if (currentEntry) {
        if (isInTimeWindow(currentEntry.line.timestamp, startTime, endTime)) {
          const shouldContinue = onEntry(currentEntry);
          count++;
          if (shouldContinue === false || (maxEntries && count >= maxEntries)) {
            stopped = true;
            rl.close();
            stream.destroy();
            return;
          }
        }
        currentEntry = null;
      }
    };

    rl.on("line", (rawLine) => {
      if (stopped) return;

      // Strip BOM from first line
      let line = rawLine;
      if (firstChar) {
        firstChar = false;
        if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      }

      lineNum++;
      const parsed = parseLogLine(line, lineNum);
      if (parsed) {
        flush();
        if (stopped) return;
        currentEntry = { line: parsed, continuationLines: [], fullText: line };
      } else if (currentEntry) {
        currentEntry.continuationLines.push(line);
        currentEntry.fullText += "\n" + line;
      }
    });

    rl.on("close", () => {
      if (!stopped) flush();
      resolve(count);
    });

    rl.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Build a helpful "no files found" error message showing what was searched
 * and what prefixes are available in the log directory.
 */
export async function buildNoFilesFoundMessage(
  fileRefs: string[],
  logDir: string | string[],
): Promise<string> {
  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const allFiles = await listLogFiles(dirs);
  const availablePrefixes = [...new Set(allFiles.map(f => f.prefix))].sort();

  const lines = [
    `No log files found matching: ${fileRefs.join(", ")}`,
    `Searched ${dirs.length} director${dirs.length > 1 ? "ies" : "y"}:`,
    ...dirs.map(d => `  ${d}`),
  ];

  if (availablePrefixes.length > 0) {
    lines.push(`Available prefixes (${availablePrefixes.length}): ${availablePrefixes.join(", ")}`);
  } else {
    lines.push("No Symphony log files found in the search directories.");
  }

  return lines.join("\n");
}

/**
 * Try to read and parse log entries from a file. On failure, pushes a warning
 * to the provided array and returns null instead of throwing.
 */
export async function tryReadLogEntries(
  fullPath: string,
  warnings: string[],
  maxLines?: number,
): Promise<LogEntry[] | null> {
  try {
    return await readLogEntries(fullPath, maxLines);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`[WARNING] Could not read file ${path.basename(fullPath)}: ${msg}`);
    return null;
  }
}

/**
 * Try to read raw lines from a file. On failure, pushes a warning
 * to the provided array and returns null instead of throwing.
 */
export async function tryReadRawLines(
  fullPath: string,
  warnings: string[],
  maxLines?: number,
): Promise<string[] | null> {
  try {
    return await readRawLines(fullPath, maxLines);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`[WARNING] Could not read file ${path.basename(fullPath)}: ${msg}`);
    return null;
  }
}

/**
 * Try to read raw lines with time filter. On failure, pushes a warning
 * to the provided array and returns null instead of throwing.
 */
export async function tryReadRawLinesWithTimeFilter(
  fullPath: string,
  warnings: string[],
  startTime?: string,
  endTime?: string,
): Promise<string[] | null> {
  try {
    return await readRawLinesWithTimeFilter(fullPath, startTime, endTime);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`[WARNING] Could not read file ${path.basename(fullPath)}: ${msg}`);
    return null;
  }
}

/** Append file-read warnings to tool output text. Returns output unchanged if no warnings. */
export function appendWarnings(output: string, warnings: string[]): string {
  if (warnings.length === 0) return output;
  return output + "\n\n" + warnings.join("\n");
}

/** Format bytes for display */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
