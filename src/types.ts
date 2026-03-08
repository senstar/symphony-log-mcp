import type { BugReport } from "./lib/bug-report.js";

/** Runtime context for tool dispatch — lazy-initialized from the log directory. */
export interface LogContext {
  /** One or more directories containing extracted .txt log files */
  dirs: string | string[];
  /** Server labels parallel to dirs[] — set when in bug-report mode */
  serverLabels?: string[];
  /** Parsed bug report metadata (null when pointing at a plain log folder) */
  bugReport: BugReport | null;
}
