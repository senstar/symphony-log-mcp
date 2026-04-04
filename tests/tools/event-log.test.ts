/**
 * Tests for the event-log tool (sym_eventlog).
 * Tests parsing of Windows Event Log text exports and filtering/summary modes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolEventLog, type EventLogArgs } from "../../src/tools/event-log.js";
import type { BugReport, ServerExtras } from "../../src/lib/bug-report.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Mock event log content ──────────────────────────────────────────────────

const EVENT_LOG_APP_CONTENT = [
  '2026/03/08 10:34:21 ID: 0x0000000B EventType:  1 Source: SenstarInfoService',
  '\tString1: Service encountered an error String2: System.OutOfMemoryException',
  '2026/03/08 09:00:00 ID: 0x00000001 EventType:  4 Source: docker',
  '\tString1: sending event String2: module=libcontainerd namespace=moby',
  '2026/03/08 08:30:00 ID: 0x00000005 EventType:  2 Source: SenstarScheduler',
  '\tString1: Database connection timeout',
  '2026/03/08 08:00:00 ID: 0x0000000A EventType:  1 Source: .NET Runtime',
  '\tString1: Application crashed String2: System.AccessViolationException at 0x7FF',
  '2026/03/08 07:30:00 ID: 0x0000000B EventType:  1 Source: SenstarInfoService',
  '\tString1: License check failed String2: No response from license server',
].join('\n');

const EVENT_LOG_SYS_CONTENT = [
  '2026/03/08 11:00:00 ID: 0x00000064 EventType:  1 Source: disk',
  '\tString1: The driver detected a controller error on \\Device\\Harddisk0\\DR0',
  '2026/03/08 10:00:00 ID: 0x00000032 EventType:  2 Source: Microsoft-Windows-Kernel-Power',
  '\tString1: The system has resumed from sleep',
  '2026/03/08 09:30:00 ID: 0x00000064 EventType:  1 Source: disk',
  '\tString1: The driver detected a controller error on \\Device\\Harddisk1\\DR1',
].join('\n');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBugReport(extras: Partial<ServerExtras>): BugReport {
  return {
    folderPath: "/fake",
    productVersion: "7.3.2.1",
    farmName: "TestFarm",
    logStartTime: "2026/03/08 07:00:00",
    logEndTime: "2026/03/08 12:00:00",
    problemDescription: "test",
    timeOfError: "2026/03/08 10:00:00",
    servers: [
      {
        label: "SERVER1",
        isClient: false,
        logDir: "/fake/server1/Log",
        extras: extras as ServerExtras,
        zipPath: "/fake/server1.zip",
      } as any,
    ],
  };
}

async function writeTemp(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evtlog-test-"));
  const filePath = path.join(dir, "temp.txt");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function cleanTemp(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("toolEventLog", () => {
  it("returns error when no bug report provided", async () => {
    const result = await toolEventLog(null, { log: "application" });
    expect(result).toContain("bug report");
  });

  it("returns no-data when servers have no extras", async () => {
    const br: BugReport = {
      folderPath: "/fake",
      productVersion: "7.3.2.1",
      farmName: "TestFarm",
      logStartTime: "",
      logEndTime: "",
      problemDescription: "",
      timeOfError: "",
      servers: [{ label: "S1", isClient: false, logDir: "/fake", extras: undefined } as any],
    };
    const result = await toolEventLog(br, { log: "application" });
    expect(result).toContain("No server data");
  });

  describe("entries mode", () => {
    let appFile: string;
    let sysFile: string;

    beforeAll(async () => {
      appFile = await writeTemp(EVENT_LOG_APP_CONTENT);
      sysFile = await writeTemp(EVENT_LOG_SYS_CONTENT);
    });
    afterAll(async () => {
      await cleanTemp(appFile);
      await cleanTemp(sysFile);
    });

    it("parses application event log entries", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "entries" });
      expect(result).toContain("SERVER1");
      expect(result).toContain("SenstarInfoService");
      expect(result).toContain("OutOfMemoryException");
    });

    it("parses system event log entries", async () => {
      const br = makeBugReport({ eventLogSysTxt: sysFile });
      const result = await toolEventLog(br, { log: "system", mode: "entries" });
      expect(result).toContain("disk");
      expect(result).toContain("controller error");
    });

    it("merges both logs when log=both", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile, eventLogSysTxt: sysFile });
      const result = await toolEventLog(br, { log: "both", mode: "entries" });
      expect(result).toContain("SenstarInfoService");
      expect(result).toContain("disk");
    });

    it("filters by level=error", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "entries", level: "error" });
      expect(result).toContain("Error");
      expect(result).not.toContain("Information");
    });

    it("filters by source", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "entries", source: "docker" });
      expect(result).toContain("docker");
      expect(result).not.toContain("SenstarInfoService");
    });

    it("filters by eventId", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      // eventId 0x0B = 11
      const result = await toolEventLog(br, { log: "application", mode: "entries", eventId: 11 });
      expect(result).toContain("SenstarInfoService");
    });

    it("respects limit parameter", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "entries", limit: 2 });
      expect(result).toContain("showing 2");
    });
  });

  describe("summary mode", () => {
    let appFile: string;

    beforeAll(async () => {
      appFile = await writeTemp(EVENT_LOG_APP_CONTENT);
    });
    afterAll(async () => {
      await cleanTemp(appFile);
    });

    it("returns level breakdown", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "summary" });
      expect(result).toContain("By Level");
      expect(result).toContain("Error");
    });

    it("returns source breakdown", async () => {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", mode: "summary" });
      expect(result).toContain("By Source");
      expect(result).toContain("SenstarInfoService");
    });
  });

  it("handles missing event log files gracefully", async () => {
    const br = makeBugReport({ eventLogAppTxt: "/nonexistent/file.txt" });
    const result = await toolEventLog(br, { log: "application", mode: "entries" });
    expect(result).toContain("not available");
  });

  it("filters by search text", async () => {
    const appFile = await writeTemp(EVENT_LOG_APP_CONTENT);
    try {
      const br = makeBugReport({ eventLogAppTxt: appFile });
      const result = await toolEventLog(br, { log: "application", search: "OutOfMemory" });
      expect(result).toContain("OutOfMemoryException");
    } finally {
      await cleanTemp(appFile);
    }
  });
});
