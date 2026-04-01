import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolStorage } from "../../src/tools/storage.js";
import { RE_DELETE } from "../../src/tools/storage.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { CLEANER_LOG_CONTENT } from "../fixtures.js";
import * as fs from "fs/promises";
import * as path from "path";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolStorage — summary mode", () => {
  it("detects disk full, cleaner cycles, and deletions", async () => {
    const result = await toolStorage(testDir.dir, { files: ["sccl"], mode: "summary" });
    expect(result).toContain("Storage Summary");
    expect(result).toContain("Disk space warnings");
    expect(result).toContain("Cleaner cycles");
    expect(result).toContain("Cleaner runs started");
  });

  it("shows disk alerts section", async () => {
    const result = await toolStorage(testDir.dir, { files: ["sccl"], mode: "summary" });
    expect(result).toContain("Disk alerts");
    expect(result).toContain("FULL");
  });

  it("shows cleaner cycle stats", async () => {
    const result = await toolStorage(testDir.dir, { files: ["sccl"], mode: "summary" });
    expect(result).toContain("Cleaner cycles:");
    expect(result).toContain("started");
    expect(result).toContain("completed");
  });
});

describe("toolStorage — events mode", () => {
  it("lists individual events with timestamps", async () => {
    const result = await toolStorage(testDir.dir, { files: ["sccl"], mode: "events" });
    expect(result).toContain("Storage Events");
    expect(result).toContain("10:00:00");
    expect(result).toContain("cleaner");
  });
});

describe("toolStorage — timeline mode", () => {
  it("shows hourly bucket aggregation", async () => {
    const result = await toolStorage(testDir.dir, { files: ["sccl"], mode: "timeline" });
    expect(result).toContain("Storage Timeline (hourly)");
    expect(result).toContain("Hour");
    expect(result).toContain("Deletions");
    expect(result).toContain("Warns");
    expect(result).toContain("Cycles");
    expect(result).toContain("10:00");
  });

  it("aggregates multi-hour data correctly", async () => {
    const content = [
      '09:00:00.000       1 <BasicInf> Cleaner\tCleanerService.Run\tCleaner cycle started',
      '09:00:01.000       1 <BasicInf> Cleaner\tCleanerService.Delete\tDeleted 5 files, freed 1.0 GB',
      '10:00:00.000       1 <BasicInf> Cleaner\tCleanerService.Run\tCleaner cycle started',
      '10:00:01.000       1 <BasicInf> Cleaner\tCleanerService.Delete\tDeleted 10 files, freed 2.5 GB',
      '10:00:02.000       1 <Error   > Cleaner\tCleanerService.Run\tDisk D: FULL - no space left',
      '11:00:00.000       1 <BasicInf> Cleaner\tCleanerService.Run\tCleaner cycle started',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "sccl2-260302_00.txt"), content, "utf8");

    const result = await toolStorage(testDir.dir, { files: ["sccl2"], mode: "timeline" });
    expect(result).toContain("09:00");
    expect(result).toContain("10:00");
    expect(result).toContain("11:00");
  });
});

describe("toolStorage — empty logs", () => {
  it("returns clean message when no storage events", async () => {
    const content = [
      '10:00:00.000       1 <BasicInf> Service\tSomething.Run\tNo storage activity here',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "sccl9-260302_00.txt"), content, "utf8");

    const result = await toolStorage(testDir.dir, { files: ["sccl9"] });
    expect(result).toMatch(/no storage events/i);
  });

  it("returns message when no files found", async () => {
    const result = await toolStorage(testDir.dir, { files: ["nonexistent"] });
    expect(result).toMatch(/no storage log files/i);
  });
});

describe("toolStorage — tryReadLogEntries warnings", () => {
  it("propagates warnings for unreadable files", async () => {
    // Create a directory instead of a file to cause a read error
    await fs.mkdir(path.join(testDir.dir, "sccl5-260302_00.txt"));

    const result = await toolStorage(testDir.dir, { files: ["sccl5-260302_00.txt"] });
    expect(result).toContain("[WARNING]");
  });
});

describe("RE_DELETE regex", () => {
  it("matches 'Deleted file'", () => {
    expect(RE_DELETE.test("Deleted file")).toBe(true);
  });

  it("matches 'Deleted 5 files'", () => {
    expect(RE_DELETE.test("Deleted 5 files")).toBe(true);
  });

  it("matches 'Deleting 10 recordings'", () => {
    expect(RE_DELETE.test("Deleting 10 recordings")).toBe(true);
  });

  it("matches 'removed video'", () => {
    expect(RE_DELETE.test("removed video")).toBe(true);
  });

  it("matches 'Removing 3 data'", () => {
    expect(RE_DELETE.test("Removing 3 data")).toBe(true);
  });

  it("does not match unrelated log lines", () => {
    expect(RE_DELETE.test("some random log line")).toBe(false);
  });
});
