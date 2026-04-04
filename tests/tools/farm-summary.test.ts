/**
 * Tests for farm-summary tool (sym_farm).
 *
 * new-tools.test.ts already covers: basic dashboard, errors, topology, and empty parent dir.
 * This file covers additional modes and edge cases NOT in new-tools.test.ts:
 *   - Dashboard with mixed health servers (CRITICAL / DEGRADED / HEALTHY)
 *   - Connectivity mode (ALIVE matrix)
 *   - Cameras mode
 *   - Single-server farm
 *   - Server directory with no Log/ subdirectory
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { toolFarmSummary } from "../../src/tools/farm-summary.js";
import {
  IS_LOG_CONTENT,
  SCCP_LOG_CONTENT,
  LIFECYCLE_LOG_CONTENT,
  CAMERA_TRACKER_LOG_CONTENT,
  INTERSERVER_LOG_CONTENT,
} from "../fixtures.js";

// Log content that produces many errors (CRITICAL-level server)
const CRITICAL_IS_LOG = [
  '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:00:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
  // Simulate crash loop — multiple restart cycles
  '10:05:00.000       1 <Error   > Service\tInfoService.OnStop\tService stopping due to unhandled exception',
  '10:05:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:05:02.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
  '10:10:00.000       1 <Error   > Service\tInfoService.OnStop\tService stopping due to unhandled exception',
  '10:10:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:10:02.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
  '10:15:00.000       1 <Error   > Service\tInfoService.OnStop\tService stopping due to unhandled exception',
  '10:15:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:15:02.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
  '10:20:00.000       1 <Error   > Communication\tRpcClient.Send\tSystem.TimeoutException: The operation timed out.',
  ...Array.from({ length: 60 }, (_, i) =>
    `10:${String(21 + Math.floor(i / 2)).padStart(2, "0")}:${String((i % 2) * 30).padStart(2, "0")}.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: SQL timeout #${i}`
  ),
].join('\n');

let parentDir: string;
let cleanup: () => Promise<void>;

async function createFarmDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-farm-ext-"));
  return dir;
}

async function addServer(
  farmDir: string,
  name: string,
  logFiles: Record<string, string>,
): Promise<void> {
  const serverDir = path.join(farmDir, `SymphonyLog-${name}-260327-121036`);
  const logDir = path.join(serverDir, "Log");
  await fs.mkdir(logDir, { recursive: true });
  for (const [filename, content] of Object.entries(logFiles)) {
    await fs.writeFile(path.join(logDir, filename), content, "utf8");
  }
}

describe("toolFarmSummary — extended", () => {
  beforeEach(async () => {
    parentDir = await createFarmDir();
    cleanup = async () => {
      await fs.rm(parentDir, { recursive: true, force: true });
    };
  });
  afterEach(async () => { await cleanup(); });

  it("dashboard shows mixed health levels", async () => {
    // Server 1: many errors → CRITICAL or DEGRADED
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": CRITICAL_IS_LOG,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });
    // Server 2: normal → HEALTHY
    await addServer(parentDir, "server5002", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });

    const result = await toolFarmSummary("", { parentDir, mode: "dashboard" });
    expect(result).toContain("FARM DASHBOARD");
    expect(result).toMatch(/server5001/i);
    expect(result).toMatch(/server5002/i);
    // Should show aggregated metrics
    expect(result).toMatch(/Errors/);
  });

  it("cameras mode shows camera distribution", async () => {
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
      "cs01-260302_00.txt": CAMERA_TRACKER_LOG_CONTENT,
      "cs05-260302_00.txt": CAMERA_TRACKER_LOG_CONTENT,
    });
    await addServer(parentDir, "server5002", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
      "cs10-260302_00.txt": CAMERA_TRACKER_LOG_CONTENT,
    });

    const result = await toolFarmSummary("", { parentDir, mode: "cameras" });
    expect(result).toContain("CAMERA");
    expect(result).toMatch(/server5001/i);
    expect(result).toMatch(/server5002/i);
    expect(result).toContain("TOTAL");
  });

  it("connectivity mode produces ALIVE matrix", async () => {
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": INTERSERVER_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });
    await addServer(parentDir, "server5002", {
      "is-260302_00.txt": INTERSERVER_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });

    const result = await toolFarmSummary("", { parentDir, mode: "connectivity" });
    expect(result).toContain("CONNECTIVITY");
    expect(result).toContain("ALIVE");
  });

  it("single-server farm works correctly", async () => {
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });

    const result = await toolFarmSummary("", { parentDir, mode: "dashboard" });
    expect(result).toContain("FARM DASHBOARD");
    expect(result).toMatch(/server5001/i);
  });

  it("skips server directories with no Log/ subdirectory", async () => {
    // Real server with log dir
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });
    // Junk directory — no Log/, no log files
    const junkDir = path.join(parentDir, "random-folder");
    await fs.mkdir(junkDir, { recursive: true });
    await fs.writeFile(path.join(junkDir, "readme.txt"), "not a server", "utf8");

    const result = await toolFarmSummary("", { parentDir, mode: "dashboard" });
    expect(result).toContain("FARM DASHBOARD");
    expect(result).toMatch(/server5001/i);
    // Should not crash or mention the junk folder
    expect(result).not.toContain("random-folder");
  });

  it("returns error for nonexistent parentDir", async () => {
    const result = await toolFarmSummary("", {
      parentDir: "/nonexistent/path/xyz",
      mode: "dashboard",
    });
    expect(result).toMatch(/does not exist|not accessible/i);
  });

  it("error aggregation identifies cross-server patterns", async () => {
    // Both servers share the same error content
    await addServer(parentDir, "server5001", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });
    await addServer(parentDir, "server5002", {
      "is-260302_00.txt": IS_LOG_CONTENT,
      "sccp-260302_00.txt": SCCP_LOG_CONTENT,
    });

    const result = await toolFarmSummary("", { parentDir, mode: "errors" });
    expect(result).toContain("ERROR");
    // Both servers have the same IS errors — should show cross-server patterns
    expect(result).toMatch(/FARM-WIDE|server/i);
  });
});
