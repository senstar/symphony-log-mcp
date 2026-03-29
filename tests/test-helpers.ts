/**
 * Test helpers — creates temporary log directories with realistic Symphony log files.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { LogContext } from "../src/types.js";
import {
  IS_LOG_CONTENT,
  SCCP_LOG_CONTENT,
  LIFECYCLE_LOG_CONTENT,
  CLEANER_LOG_CONTENT,
  ALARM_LOG_CONTENT,
  NETWORK_LOG_CONTENT,
  ACCESS_CONTROL_LOG_CONTENT,
  VIDEO_LOG_CONTENT,
  UI_THREAD_LOG_CONTENT,
  AUTH_LOG_CONTENT,
  DB_HEALTH_LOG_CONTENT,
  INTERSERVER_LOG_CONTENT,
  HW_LOG_CONTENT,
} from "./fixtures.js";

export interface TestLogDir {
  dir: string;
  ctx: LogContext;
  cleanup: () => Promise<void>;
}

/**
 * Create a temp directory with sample log files prefixed for different Symphony services.
 * Returns the directory path, a LogContext, and a cleanup function.
 */
export async function createTestLogDir(
  extraFiles?: Record<string, string>
): Promise<TestLogDir> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-test-"));

  // Write standard log files
  const files: Record<string, string> = {
    "is-260302_00.txt": IS_LOG_CONTENT,
    "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    "sc-260302_00.txt": LIFECYCLE_LOG_CONTENT,
    "sccl-260302_00.txt": CLEANER_LOG_CONTENT,
    "scac-260302_00.txt": ALARM_LOG_CONTENT,
    "hm-260302_00.txt": NETWORK_LOG_CONTENT,
    "ac-260302_00.txt": ACCESS_CONTROL_LOG_CONTENT,
    "cs01-260302_00.txt": VIDEO_LOG_CONTENT,
    "ae-260302_00.txt": UI_THREAD_LOG_CONTENT,
    ...extraFiles,
  };

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }

  const ctx: LogContext = {
    dirs: dir,
    bugReport: null,
  };

  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true });
  };

  return { dir, ctx, cleanup };
}

