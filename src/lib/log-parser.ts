/**
 * Symphony log line parser.
 *
 * Format (from AILog.cpp LogInternal()):
 *   HH:MM:SS.mmm  THREADID <LEVEL8__> [FunctionalArea\t]Source[context]\tMessage
 *
 * Where LEVEL8 is %-8.8s — left-justified, min 8 / max 8 characters.
 * The C++ code strips "Log" prefix before formatting, so "LogError" → "Error   ".
 *
 * Stack trace continuation lines start with whitespace followed by "at ".
 * A log "entry" is the main line plus all immediately-following continuation lines.
 *
 * Log levels (8 chars padded inside <>), verified from AILog.cpp LOG_LEVELS:
 *   Error    BasicInf  MoreInfo  Verbose   Diagnost  Tracker
 *   Classifi NetCam    FrameInf  PTZMask   CMask     Policies
 *   PTZ      AlarmInf  OptFlow   Tracking  SchedAna  Stationa
 *   Live555  AccessCo  MultiHom  Fence     Alarming  TimeDrif
 *   OptFlowV Objects   MultiStr  BWInfo    IppProfi  VideoDec
 *   AudioDec All
 */

export type LogLevel =
  | "Verbose"
  | "BasicInfo"
  | "MoreInfo"
  | "Diagnostic"
  | "Error"
  | "Unknown";

export interface LogLine {
  /** Source file line number (1-based) */
  lineNumber: number;
  /** HH:MM:SS.mmm */
  timestamp: string;
  /** Fractional seconds from midnight, for arithmetic */
  timestampMs: number;
  threadId: string;
  level: LogLevel;
  /** e.g. "WebService", "Communication" — may be empty */
  functionalArea: string;
  /** e.g. "WebServiceRequestProcessor.ProcessRequest" */
  source: string;
  /** Content inside [...] on the source, e.g. "14985156 ae.exe" */
  sourceContext: string;
  message: string;
  /** Full original text of this line */
  raw: string;
}

export interface LogEntry {
  /** The primary parsed log line */
  line: LogLine;
  /** Any continuation/stack-trace lines that follow */
  continuationLines: string[];
  /** Full text including continuation lines */
  fullText: string;
}

// ------------------------------------------------------------------ helpers

const LEVEL_MAP: Record<string, LogLevel> = {
  // Primary levels — these are the most commonly seen
  "Verbose ": "Verbose",
  "BasicInf": "BasicInfo",
  "MoreInfo": "MoreInfo",
  "Diagnost": "Diagnostic",
  "Error   ": "Error",
  // Note: "LogError" never appears in logs — the C++ code strips the "Log"
  // prefix before writing, so it always appears as "Error   ". Kept for
  // defensive compatibility only.
  "LogError": "Error",
  // Sub-diagnostic levels (all are more verbose than Diagnostic).
  // Mapped to Verbose since they're detailed instrumentation.
  "Tracker ": "Verbose",
  "Classifi": "Verbose",
  "NetCam  ": "Verbose",
  "FrameInf": "Verbose",
  "PTZMask ": "Verbose",
  "CMask   ": "Verbose",
  "Policies": "Verbose",
  "PTZ     ": "Verbose",
  "AlarmInf": "Verbose",
  "OptFlow ": "Verbose",
  "Tracking": "Verbose",
  "SchedAna": "Verbose",
  "Stationa": "Verbose",
  "Live555 ": "Verbose",
  "AccessCo": "Verbose",
  "MultiHom": "Verbose",
  "Fence   ": "Verbose",
  "Alarming": "Verbose",
  "TimeDrif": "Verbose",
  "OptFlowV": "Verbose",
  "Objects ": "Verbose",
  "MultiStr": "Verbose",
  "BWInfo  ": "Verbose",
  "IppProfi": "Verbose",
  "VideoDec": "Verbose",
  "AudioDec": "Verbose",
  "All     ": "Verbose",
};

/** Regex for the header portion of a log line.
 *  C++ format: "%02i:%02i:%02i.%03i %7d <%-8.8s> " → thread ID right-justified 7 chars */
const LINE_RE =
  /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+) <([^>]{8})> (.*)$/;

/** Regex for "took HH:MM:SS.fffffff" request duration pattern */
const TOOK_RE = /took (\d{2}):(\d{2}):(\d{2})\.(\d+)/;

/** Continuation line: indented (stack frame or wrapped message) */
const CONTINUATION_RE = /^\s{2,}/;

// ------------------------------------------------------------------ timing

const MS_PER_DAY = 86_400_000;

export function timestampToMs(ts: string): number {
  const [h, m, rest] = ts.split(":");
  const [s, frac] = rest.split(".");
  return (
    parseInt(h) * 3_600_000 +
    parseInt(m) * 60_000 +
    parseInt(s) * 1_000 +
    parseInt((frac + "000").slice(0, 3))
  );
}

/** Parse "took HH:MM:SS.fffffff" → milliseconds, or null */
export function parseTookMs(message: string): number | null {
  const m = TOOK_RE.exec(message);
  if (!m) return null;
  const ms =
    parseInt(m[1]) * 3_600_000 +
    parseInt(m[2]) * 60_000 +
    parseInt(m[3]) * 1_000 +
    Math.round(parseInt((m[4] + "000").slice(0, 3)));
  return ms;
}

// ------------------------------------------------------------------ parsing

export function parseLogLine(raw: string, lineNumber: number): LogLine | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;

  const [, timestamp, threadId, levelRaw, rest] = m;
  const level: LogLevel = LEVEL_MAP[levelRaw] ?? "Unknown";
  const timestampMs = timestampToMs(timestamp);

  // rest may be:
  //   FunctionalArea\tSource[ctx]\tMessage
  //   Source[ctx]\tMessage
  //   Message (no tabs)
  const parts = rest.split("\t");

  let functionalArea = "";
  let sourceRaw = "";
  let message = "";

  if (parts.length >= 3) {
    // FunctionalArea \t Source[ctx] \t Message…
    functionalArea = parts[0].trim();
    sourceRaw = parts[1].trim();
    message = parts.slice(2).join("\t");
  } else if (parts.length === 2) {
    // Could be Source[ctx] \t Message  OR  FunctionalArea \t Message
    // Heuristic: if parts[0] contains '[' it's a source; otherwise functional area
    if (parts[0].includes("[")) {
      sourceRaw = parts[0].trim();
      message = parts[1];
    } else {
      functionalArea = parts[0].trim();
      message = parts[1];
    }
  } else {
    message = rest;
  }

  // Extract context from source: "Name[ctx]" → source="Name", ctx="ctx"
  let source = sourceRaw;
  let sourceContext = "";
  const ctxMatch = /^([^\[]+)\[([^\]]+)\]/.exec(sourceRaw);
  if (ctxMatch) {
    source = ctxMatch[1].trim();
    sourceContext = ctxMatch[2].trim();
  }

  return {
    lineNumber,
    timestamp,
    timestampMs,
    threadId,
    level,
    functionalArea,
    source,
    sourceContext,
    message,
    raw,
  };
}

/** Parse raw text lines into LogEntry objects (line + continuation lines).
 *  Detects midnight rollover: if a timestamp jumps backward by >20 hours,
 *  subsequent entries get a +24h offset on timestampMs so sorting stays correct. */
export function parseLogEntries(rawLines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  let currentEntry: LogEntry | null = null;
  let dayOffset = 0;
  let prevMs = -1;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    if (CONTINUATION_RE.test(raw)) {
      // Belongs to previous entry
      if (currentEntry) {
        currentEntry.continuationLines.push(raw);
        currentEntry.fullText += "\n" + raw;
      }
      continue;
    }

    // Attempt to parse as a new log line
    const parsed = parseLogLine(raw, i + 1);
    if (parsed) {
      // Midnight rollover detection: if raw timestamp drops by >20 hours,
      // we've crossed midnight — add a day offset.
      if (prevMs >= 0 && parsed.timestampMs < prevMs && (prevMs - parsed.timestampMs) > 20 * 3_600_000) {
        dayOffset += MS_PER_DAY;
      }
      prevMs = parsed.timestampMs;
      parsed.timestampMs += dayOffset;

      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        line: parsed,
        continuationLines: [],
        fullText: raw,
      };
    } else {
      // Non-matching, non-indented line (e.g. blank line between entries)
      if (currentEntry) {
        currentEntry.continuationLines.push(raw);
        currentEntry.fullText += "\n" + raw;
      }
    }
  }

  if (currentEntry) entries.push(currentEntry);
  return entries;
}

/** Extract a stack trace from an entry's continuation lines */
export function extractStackTrace(entry: LogEntry): string | null {
  const frames = entry.continuationLines.filter((l) =>
    /\s+at\s+/.test(l)
  );
  if (frames.length === 0) return null;
  return entry.line.message + "\n" + frames.join("\n");
}

/** Is this a C++ native stack trace line? (contains !  or  +0x  patterns) */
export function isNativeStackFrame(line: string): boolean {
  return /[!+]0x[0-9a-fA-F]+|^[0-9a-fA-F]{8,16}\s/.test(line);
}
