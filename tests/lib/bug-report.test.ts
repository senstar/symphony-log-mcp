import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { isBugReportFolder, extractBugReport } from "../../src/lib/bug-report.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bug-report-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("isBugReportFolder", () => {
  it("returns true for directory containing a server SymphonyLog zip", async () => {
    await fs.writeFile(
      path.join(tmpDir, "SymphonyLog-10.60.31.4-260128-103000.zip"),
      "fake-zip-content",
    );
    expect(await isBugReportFolder(tmpDir)).toBe(true);
  });

  it("returns true for directory containing a client SymphonyLog zip", async () => {
    await fs.writeFile(
      path.join(tmpDir, "SymphonyLog-client-260128-103000.zip"),
      "fake-zip-content",
    );
    expect(await isBugReportFolder(tmpDir)).toBe(true);
  });

  it("returns false for empty directory", async () => {
    expect(await isBugReportFolder(tmpDir)).toBe(false);
  });

  it("returns false for directory with only regular .txt files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "hello");
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "world");
    expect(await isBugReportFolder(tmpDir)).toBe(false);
  });

  it("returns false for nonexistent directory", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    expect(await isBugReportFolder(nonexistent)).toBe(false);
  });

  it("returns true when zip is mixed with other files", async () => {
    await fs.writeFile(path.join(tmpDir, "bugreport.txt"), "metadata");
    await fs.writeFile(path.join(tmpDir, "serverinfo.txt"), "info");
    await fs.writeFile(
      path.join(tmpDir, "SymphonyLog-10.60.31.4-260128-103000.zip"),
      "fake",
    );
    expect(await isBugReportFolder(tmpDir)).toBe(true);
  });
});

describe("extractBugReport", () => {
  it("parses bugreport.txt metadata", async () => {
    const bugreportTxt = [
      "Product Version: 7.3.2.1",
      "Farm Name: TestFarm",
      "Log Start Time: 2026-01-28 10:00:00",
      "Log End Time: 2026-01-28 12:00:00",
      "Problem Description: Cameras going offline",
      "Time of Error: 2026-01-28 10:34:00",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, "bugreport.txt"), bugreportTxt);

    const report = await extractBugReport(tmpDir);

    expect(report.folderPath).toBe(tmpDir);
    expect(report.productVersion).toBe("7.3.2.1");
    expect(report.farmName).toBe("TestFarm");
    expect(report.logStartTime).toBe("2026-01-28 10:00:00");
    expect(report.logEndTime).toBe("2026-01-28 12:00:00");
    expect(report.problemDescription).toBe("Cameras going offline");
    expect(report.timeOfError).toBe("2026-01-28 10:34:00");
  });

  it("returns empty strings when bugreport.txt is missing", async () => {
    const report = await extractBugReport(tmpDir);
    expect(report.productVersion).toBe("");
    expect(report.farmName).toBe("");
    expect(report.problemDescription).toBe("");
  });

  it("returns empty servers array when no zips are present", async () => {
    const report = await extractBugReport(tmpDir);
    expect(report.servers).toEqual([]);
  });

  it("recognises client zip as a client server entry", async () => {
    await fs.writeFile(
      path.join(tmpDir, "SymphonyLog-client-260128-103000.zip"),
      "fake",
    );
    // extractBugReport will try to open the client zip but the Client entry
    // is added without extraction (CLIENT_ZIP_RE match creates a stub).
    const report = await extractBugReport(tmpDir);
    const client = report.servers.find((s) => s.isClient);
    expect(client).toBeDefined();
    expect(client!.serverName).toBe("Client");
    expect(client!.logDir).toBe("");
  });

  it("extracts a real zip with log files inside", async () => {
    // Use AdmZip to create a minimal zip with an ai_logs/ entry
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    const logContent =
      "10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting\n";
    zip.addFile("ai_logs/is-260128_00.txt", Buffer.from(logContent, "utf8"));
    const zipPath = path.join(tmpDir, "SymphonyLog-10.60.31.4-260128-103000.zip");
    zip.writeZip(zipPath);

    const report = await extractBugReport(tmpDir);

    const server = report.servers.find((s) => s.serverIp === "10.60.31.4");
    expect(server).toBeDefined();
    expect(server!.isClient).toBe(false);
    expect(server!.logDir).toBeTruthy();

    // Verify the log file was extracted
    const extracted = await fs.readdir(server!.logDir);
    expect(extracted).toContain("is-260128_00.txt");
  });

  it("parses serverinfo.txt to populate server names and master flag", async () => {
    const serverInfoTxt = [
      "--- Server Info (CCTVSRV04) ---",
      "IP: 10.60.31.4 (This Server) (Master)",
      "OS Version: Microsoft Windows Server 2019 Standard",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, "serverinfo.txt"), serverInfoTxt);

    // Create a minimal zip for this server
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile(
      "ai_logs/is-260128_00.txt",
      Buffer.from("10:00:00.000       1 <BasicInf> Service\tTest\ttest\n", "utf8"),
    );
    zip.writeZip(path.join(tmpDir, "SymphonyLog-10.60.31.4-260128-103000.zip"));

    const report = await extractBugReport(tmpDir);
    const server = report.servers.find((s) => s.serverIp === "10.60.31.4");
    expect(server).toBeDefined();
    expect(server!.serverName).toBe("CCTVSRV04");
    expect(server!.isMaster).toBe(true);
    expect(server!.label).toContain("CCTVSRV04");
    expect(server!.label).toContain("[Master]");
  });

  it("sorts servers: master first, client last", async () => {
    const AdmZip = (await import("adm-zip")).default;
    const logContent = Buffer.from(
      "10:00:00.000       1 <BasicInf> Service\tTest\ttest\n",
      "utf8",
    );

    // Create two server zips + one client zip
    const zip1 = new AdmZip();
    zip1.addFile("ai_logs/is-260128_00.txt", logContent);
    zip1.writeZip(path.join(tmpDir, "SymphonyLog-10.60.31.5-260128-103000.zip"));

    const zip2 = new AdmZip();
    zip2.addFile("ai_logs/is-260128_00.txt", logContent);
    zip2.writeZip(path.join(tmpDir, "SymphonyLog-10.60.31.4-260128-103000.zip"));

    await fs.writeFile(
      path.join(tmpDir, "SymphonyLog-client-260128-103000.zip"),
      "fake",
    );

    // Mark 10.60.31.4 as master via serverinfo.txt
    await fs.writeFile(
      path.join(tmpDir, "serverinfo.txt"),
      "--- Server Info (SRV1) ---\nIP: 10.60.31.4 (This Server) (Master)\n",
    );

    const report = await extractBugReport(tmpDir);
    expect(report.servers.length).toBe(3);
    expect(report.servers[0].isMaster).toBe(true);
    expect(report.servers[report.servers.length - 1].isClient).toBe(true);
  });
});
