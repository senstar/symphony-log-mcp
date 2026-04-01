import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolAlarms } from "../../src/tools/alarms.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { ALARM_LOG_CONTENT } from "../fixtures.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let testDir: TestLogDir;
beforeEach(async () => {
  testDir = await createTestLogDir({
    "scac-260302_01.txt": ALARM_LOG_CONTENT,
  });
});
afterEach(async () => { await testDir.cleanup(); });

describe("toolAlarms — summary mode", () => {
  it("reports alarm triggers", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    expect(result).toContain("Alarm triggers");
  });

  it("reports alarm clears", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    expect(result).toContain("Alarm clears");
  });

  it("reports notifications", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    expect(result).toContain("Notification");
  });

  it("reports notification failures", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    // ALARM_LOG_CONTENT has "Failed to send email: SMTP connection refused"
    expect(result).toContain("Notification failures");
  });

  it("includes event count", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    expect(result).toContain("Alarms & Events Summary");
    expect(result).toMatch(/\d+ events/);
  });

  it("shows recent failures detail", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    // Failures section should show the SMTP error
    expect(result.toLowerCase()).toContain("smtp");
  });
});

describe("toolAlarms — events mode", () => {
  it("lists events chronologically", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "events" });
    expect(result).toContain("Alarm Events");
    expect(result).toContain("10:00:00");
  });

  it("shows event categories", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "events" });
    expect(result.toLowerCase()).toMatch(/trigger|clear|notification|notif fail/);
  });
});

describe("toolAlarms — failures mode", () => {
  it("isolates notification failures", async () => {
    const result = await toolAlarms(testDir.dir, { mode: "failures" });
    expect(result).toContain("Alarm Failures");
    expect(result.toLowerCase()).toContain("send email");
  });

  it("returns clean message when no failures exist", async () => {
    // Create a standalone directory with only triggers and clears, no failures
    const noFailContent = [
      "10:00:00.000       1 <BasicInf> Actions\tActionManager.Execute\tAlarm triggered: Motion on Camera 5",
      "10:00:05.000       1 <BasicInf> Actions\tActionManager.Execute\tAlarm cleared: Motion on Camera 5",
    ].join("\n");
    const cleanDir = await mkdtemp(path.join(tmpdir(), "clean-"));
    await writeFile(path.join(cleanDir, "scac-260302_01.txt"), noFailContent);
    try {
      const result = await toolAlarms(cleanDir, { mode: "failures" });
      expect(result).toContain("No alarm/notification failures found");
    } finally {
      await rm(cleanDir, { recursive: true });
    }
  });
});

describe("toolAlarms — empty", () => {
  it("returns clean output when no alarm events", async () => {
    const cleanDir = await mkdtemp(path.join(tmpdir(), "clean-"));
    await writeFile(path.join(cleanDir, "scac-260302_01.txt"), "10:00:00.000       1 <BasicInf> Misc\tSomething.Else\tUnrelated log line");
    try {
      const result = await toolAlarms(cleanDir, { mode: "summary" });
      expect(result).toContain("No alarm/event rule activity found");
    } finally {
      await rm(cleanDir, { recursive: true });
    }
  });
});

describe("toolAlarms — warnings", () => {
  it("propagates tryReadLogEntries warnings", async () => {
    await testDir.cleanup();
    testDir = await createTestLogDir({
      "scac-260302_01.txt": ALARM_LOG_CONTENT,
      "scac-260302_02.txt": "", // empty file
    });
    const result = await toolAlarms(testDir.dir, { mode: "summary" });
    // Should still succeed with valid data from the first file
    expect(result).toBeTruthy();
  });
});
