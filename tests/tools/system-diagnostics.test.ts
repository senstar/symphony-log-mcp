/**
 * Tests for system-diagnostics tool (sym_system).
 * Tests supplementary file parsing across multiple modes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolSystemDiag, type SystemDiagArgs } from "../../src/tools/system-diagnostics.js";
import type { BugReport, ServerExtras } from "../../src/lib/bug-report.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Mock supplementary file content ─────────────────────────────────────────

const SERVICES_CONTENT = [
  'SERVICE_NAME: SenstarSymphonyInfoService',
  '        DISPLAY_NAME: Senstar Symphony Information Service',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 4  RUNNING',
  '        PID                : 1234',
  '',
  'SERVICE_NAME: SenstarSymphonyScheduler',
  '        DISPLAY_NAME: Senstar Symphony Scheduler',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 1  STOPPED',
  '        PID                : 0',
  '',
  'SERVICE_NAME: Spooler',
  '        DISPLAY_NAME: Print Spooler',
  '        TYPE               : 110  WIN32_OWN_PROCESS  (interactive)',
  '        STATE              : 4  RUNNING',
  '        PID                : 2222',
].join('\n');

const IPCONFIG_CONTENT = [
  'Windows IP Configuration',
  '',
  '   Host Name . . . . . . . . . . . . : SERVER5001',
  '   Primary Dns Suffix  . . . . . . . : corp.local',
  '',
  'Ethernet adapter Ethernet0:',
  '',
  '   Connection-specific DNS Suffix  . :',
  '   IPv4 Address. . . . . . . . . . . : 10.60.31.4',
  '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
  '   Default Gateway . . . . . . . . . : 10.60.31.1',
  '   DNS Servers . . . . . . . . . . . : 10.60.31.2',
  '                                        10.60.31.3',
].join('\n');

const NETSTAT_CONTENT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:50000          0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:50001          0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:8443           0.0.0.0:0              LISTENING       5678',
  '  TCP    10.60.31.4:50000       10.60.31.10:51234      ESTABLISHED     1234',
  '  TCP    10.60.31.4:50000       10.60.31.11:52000      ESTABLISHED     1234',
  '  TCP    10.60.31.4:50001       10.60.31.10:53000      TIME_WAIT       1234',
].join('\n');

const TASKLIST_CONTENT = [
  '',
  'Image Name                     PID Session Name        Session#    Mem Usage Status          User Name                                              CPU Time Window Title',
  '========================= ======== ================ =========== ============ =============== ================================================== ============ ========================================================================',
  'infoservice.exe               1234 Services                   0    245,123 K Running         NT AUTHORITY\\SYSTEM                                   1:23:45 N/A',
  'scheduler.exe                 5678 Services                   0    112,456 K Running         NT AUTHORITY\\SYSTEM                                   0:45:12 N/A',
  'ae.exe                        3456 Console                    1    198,000 K Running         DOMAIN\\operator                                       0:12:34 AiraExplorer',
  'trackerapp.exe                9012 Services                   0    523,000 K Running         NT AUTHORITY\\SYSTEM                                   2:15:00 N/A',
].join('\n');

const SYSTEMINFO_CONTENT = [
  'Host Name:                 SERVER5001',
  'OS Name:                   Microsoft Windows Server 2019 Standard',
  'OS Version:                10.0.17763 N/A Build 17763',
  'System Manufacturer:       Dell Inc.',
  'System Model:              PowerEdge R740',
  'System Type:               x64-based PC',
  'Processor(s):              1 Processor(s) Installed.',
  '                           [01]: Intel64 Family 6 Model 85 Stepping 7 GenuineIntel ~2100 Mhz',
  'Total Physical Memory:     32,768 MB',
  'Available Physical Memory: 18,500 MB',
  'System Boot Time:          3/7/2026, 6:00:00 AM',
  'Hotfix(s):                 3 Hotfix(s) Installed.',
  '                           [01]: KB5001234',
  '                           [02]: KB5005678',
  '                           [03]: KB5009012',
].join('\n');

// ── Helpers ─────────────────────────────────────────────────────────────────

async function writeTemp(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sysdiag-test-"));
  const filePath = path.join(dir, "temp.txt");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function cleanTemp(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("toolSystemDiag", () => {
  it("returns error when no bug report provided", async () => {
    const result = await toolSystemDiag(null, { mode: "overview" });
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
      servers: [{ label: "S1", isClient: false, logDir: "/f", extras: undefined } as any],
    };
    const result = await toolSystemDiag(br, { mode: "overview" });
    expect(result).toContain("No server data");
  });

  describe("services mode", () => {
    let svcFile: string;

    beforeAll(async () => { svcFile = await writeTemp(SERVICES_CONTENT); });
    afterAll(async () => { await cleanTemp(svcFile); });

    it("lists all services", async () => {
      const br = makeBugReport({ servicesTxt: svcFile });
      const result = await toolSystemDiag(br, { mode: "services" });
      expect(result).toContain("SenstarSymphonyInfoService");
      expect(result).toContain("RUNNING");
      expect(result).toContain("Spooler");
    });

    it("filters by service name", async () => {
      const br = makeBugReport({ servicesTxt: svcFile });
      const result = await toolSystemDiag(br, { mode: "services", filter: "Senstar" });
      expect(result).toContain("SenstarSymphonyInfoService");
      expect(result).not.toContain("Spooler");
    });

    it("symphonyOnly flag filters non-Symphony services", async () => {
      const br = makeBugReport({ servicesTxt: svcFile });
      const result = await toolSystemDiag(br, { mode: "services", symphonyOnly: true });
      expect(result).toContain("Senstar");
      expect(result).not.toContain("Spooler");
    });

    it("handles missing services.txt", async () => {
      const br = makeBugReport({ servicesTxt: "/nonexistent.txt" });
      const result = await toolSystemDiag(br, { mode: "services" });
      expect(result).toContain("not available");
    });
  });

  describe("processes mode", () => {
    let taskFile: string;

    beforeAll(async () => { taskFile = await writeTemp(TASKLIST_CONTENT); });
    afterAll(async () => { await cleanTemp(taskFile); });

    it("lists processes sorted by memory", async () => {
      const br = makeBugReport({ tasklistTxt: taskFile });
      const result = await toolSystemDiag(br, { mode: "processes" });
      expect(result).toContain("infoservice.exe");
      expect(result).toContain("trackerapp.exe");
    });

    it("filters by process name", async () => {
      const br = makeBugReport({ tasklistTxt: taskFile });
      const result = await toolSystemDiag(br, { mode: "processes", filter: "tracker" });
      expect(result).toContain("trackerapp.exe");
      expect(result).not.toContain("scheduler.exe");
    });
  });

  describe("network mode", () => {
    let ipFile: string;
    let nsFile: string;

    beforeAll(async () => {
      ipFile = await writeTemp(IPCONFIG_CONTENT);
      nsFile = await writeTemp(NETSTAT_CONTENT);
    });
    afterAll(async () => {
      await cleanTemp(ipFile);
      await cleanTemp(nsFile);
    });

    it("shows ipconfig and netstat data", async () => {
      const br = makeBugReport({ ipconfigTxt: ipFile, netstatTxt: nsFile });
      const result = await toolSystemDiag(br, { mode: "network" });
      expect(result).toContain("SERVER1");
      expect(result).toContain("10.60.31.4");
      expect(result).toContain("Listening");
    });

    it("filters by port number", async () => {
      const br = makeBugReport({ netstatTxt: nsFile });
      const result = await toolSystemDiag(br, { mode: "network", port: 50000 });
      expect(result).toContain("50000");
    });
  });

  describe("overview mode", () => {
    let svcFile: string;
    let sysFile: string;
    let nsFile: string;

    beforeAll(async () => {
      svcFile = await writeTemp(SERVICES_CONTENT);
      sysFile = await writeTemp(SYSTEMINFO_CONTENT);
      nsFile = await writeTemp(NETSTAT_CONTENT);
    });
    afterAll(async () => {
      await cleanTemp(svcFile);
      await cleanTemp(sysFile);
      await cleanTemp(nsFile);
    });

    it("combines system info, services, and network", async () => {
      const br = makeBugReport({
        servicesTxt: svcFile,
        systeminfoTxt: sysFile,
        netstatTxt: nsFile,
      });
      const result = await toolSystemDiag(br, { mode: "overview" });
      expect(result).toContain("SERVER1");
      expect(result).toContain("Windows Server 2019");
      expect(result).toContain("Symphony Services");
    });
  });

  describe("raw mode", () => {
    let svcFile: string;

    beforeAll(async () => { svcFile = await writeTemp(SERVICES_CONTENT); });
    afterAll(async () => { await cleanTemp(svcFile); });

    it("dumps a supplementary file as-is", async () => {
      const br = makeBugReport({ servicesTxt: svcFile });
      const result = await toolSystemDiag(br, { mode: "raw", file: "services" });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  it("throws on unknown mode", async () => {
    const svcFile = await writeTemp(SERVICES_CONTENT);
    try {
      const br = makeBugReport({ servicesTxt: svcFile });
      await expect(
        toolSystemDiag(br, { mode: "invalid_mode" as any })
      ).rejects.toThrow(/unknown mode/i);
    } finally {
      await cleanTemp(svcFile);
    }
  });
});
