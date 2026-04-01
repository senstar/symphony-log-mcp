import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolDbHealth } from "../../src/tools/db-health.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { DB_HEALTH_LOG_CONTENT } from "../fixtures.js";

let testDir: TestLogDir;
beforeEach(async () => {
  testDir = await createTestLogDir({ 'is-260301_00.txt': DB_HEALTH_LOG_CONTENT });
});
afterEach(async () => { await testDir.cleanup(); });

describe("toolDbHealth — summary mode", () => {
  it("detects connection failures", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary" });
    expect(result).toContain("DATABASE HEALTH SUMMARY");
    expect(result).toContain("connection failure");
  });

  it("detects SQL exceptions", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary" });
    expect(result).toContain("sql error");
  });

  it("detects pool issues", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary" });
    expect(result).toContain("pool issue");
  });

  it("detects outage windows in summary", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary" });
    // The 3 DbConnectionFailedException events at 11:44:00, 11:44:02, 11:44:05 are within 60s
    expect(result).toContain("OUTAGE WINDOW");
  });

  it("reports total event count", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary" });
    expect(result).toContain("Total events:");
  });
});

describe("toolDbHealth — outages mode", () => {
  it("clusters failures within 60s into outage windows", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "outages" });
    expect(result).toContain("outage window");
    expect(result).toContain("11:44:00");
    expect(result).toContain("11:44:05");
  });

  it("reports event count in outage", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "outages" });
    // 3 DbConnectionFailedException events form the outage
    expect(result).toContain("3");
  });
});

describe("toolDbHealth — events mode", () => {
  it("lists individual events", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "events" });
    expect(result).toContain("database event");
    expect(result).toContain("DbConnectionFailedException");
  });

  it("shows recovery events", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "events" });
    expect(result).toContain("recovery");
    expect(result).toContain("✓");
  });

  it("shows SQL error events", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "events" });
    expect(result).toContain("deadlock");
  });
});

describe("toolDbHealth — clean database", () => {
  it("returns clean output when no DB errors", async () => {
    // SCCP logs have CPU stats, no DB events
    const result = await toolDbHealth(testDir.dir, { mode: "summary", files: ["sccp"] });
    expect(result).toContain("No database health events found");
  });
});

describe("toolDbHealth — single failure (no outage)", () => {
  it("does not form outage window with fewer than 3 events", async () => {
    const fewFailures = [
      '11:44:00.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: Unable to connect to SQL Server on SQLTEST01',
      '11:44:02.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: Unable to connect to SQL Server on SQLTEST01',
    ].join('\n');

    const dir = await createTestLogDir({ 'is-260303_00.txt': fewFailures });
    try {
      const result = await toolDbHealth(dir.dir, { mode: "outages", files: ["is-260303_00.txt"] });
      expect(result).toContain("No outage windows detected");
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toolDbHealth — warnings", () => {
  it("returns no-files message for nonexistent prefix", async () => {
    const result = await toolDbHealth(testDir.dir, { mode: "summary", files: ["nonexistent-260101_00.txt"] });
    expect(result).toContain("No log files found");
  });
});
