import { describe, it, expect } from "vitest";
import { parseServerInfoForHardware, formatHardwareConfig } from "../../src/lib/config-parser.js";
import { SERVER_INFO_TXT } from "../fixtures.js";

describe("parseServerInfoForHardware", () => {
  const servers = parseServerInfoForHardware(SERVER_INFO_TXT);

  it("returns 2 servers", () => {
    expect(servers).toHaveLength(2);
  });

  it("SERVER1 is master, SERVER2 is not", () => {
    const s1 = servers.find(s => s.serverName === "SERVER1");
    const s2 = servers.find(s => s.serverName === "SERVER2");
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1!.isMaster).toBe(true);
    expect(s2!.isMaster).toBe(false);
  });

  it("parses disk info for SERVER1", () => {
    const s1 = servers.find(s => s.serverName === "SERVER1")!;
    expect(s1.disks).toHaveLength(2);

    const cDrive = s1.disks.find(d => d.drive === "C:");
    expect(cDrive).toBeDefined();
    expect(cDrive!.totalGB).toBeCloseTo(237.9, 1);
    expect(cDrive!.freeGB).toBeCloseTo(112.3, 1);
    expect(cDrive!.usedPercent).toBeGreaterThan(0);

    const dDrive = s1.disks.find(d => d.drive === "D:");
    expect(dDrive).toBeDefined();
    expect(dDrive!.totalGB).toBeCloseTo(1863.0, 0);
    expect(dDrive!.freeGB).toBeCloseTo(891.2, 0);
  });

  it("parses CPU, RAM, version, and service account", () => {
    const s1 = servers.find(s => s.serverName === "SERVER1")!;
    expect(s1.cpuModel).toContain("Xeon");
    expect(s1.cpuCores).toBe(6);
    expect(s1.cpuLogicalProcessors).toBe(12);
    expect(s1.totalRamGB).toBeCloseTo(32.0, 0);
    expect(s1.availableRamGB).toBeCloseTo(18.5, 1);
    expect(s1.symphonyVersion).toBe("7.3.2.1");
    expect(s1.serviceAccount).toBe("LocalSystem");
  });

  it("parses SERVER1 IP and OS", () => {
    const s1 = servers.find(s => s.serverName === "SERVER1")!;
    expect(s1.serverIp).toContain("10.60.31.4");
    expect(s1.osVersion).toContain("Windows Server 2019");
    expect(s1.osBuild).toBe("17763");
    expect(s1.databaseServer).toBe("SERVER1\\SQLEXPRESS");
  });
});

describe("formatHardwareConfig", () => {
  it("produces non-empty output with server names and MASTER tag", () => {
    const servers = parseServerInfoForHardware(SERVER_INFO_TXT);
    const output = formatHardwareConfig(servers);
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("SERVER1");
    expect(output).toContain("SERVER2");
    expect(output).toContain("[MASTER]");
  });

  it("returns placeholder for empty array", () => {
    expect(formatHardwareConfig([])).toBe("No hardware configuration available.");
  });
});

