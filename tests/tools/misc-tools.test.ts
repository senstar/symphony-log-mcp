import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolGetProcessLifetimes } from "../../src/tools/process-lifetimes.js";
import { toolGetStackTraces } from "../../src/tools/stack-traces.js";
import { toolListLogFiles } from "../../src/tools/list-logs.js";
import { summarizeProcessNames } from "../../src/tools/triage.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolGetProcessLifetimes", () => {
  it("extracts process lifetimes from sccp", async () => {
    const result = await toolGetProcessLifetimes(testDir.dir, {
      files: ["sccp"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters symphony-only processes", async () => {
    const result = await toolGetProcessLifetimes(testDir.dir, {
      files: ["sccp"],
      symphonyOnly: true,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolGetStackTraces", () => {
  it("extracts stack traces from IS logs", async () => {
    const result = await toolGetStackTraces(testDir.dir, {
      files: ["is"],
    });
    expect(result).toContain("AlarmProvider");
  });

  it("handles files without stack traces", async () => {
    const result = await toolGetStackTraces(testDir.dir, {
      files: ["sccp"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolListLogFiles", () => {
  it("lists all log files", async () => {
    const result = await toolListLogFiles(testDir.dir, {});
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by prefix", async () => {
    const result = await toolListLogFiles(testDir.dir, {
      prefix: "is",
    });
    expect(result).toContain("is-260302");
    expect(result).not.toContain("sccp-260302");
  });
});

describe("summarizeProcessNames", () => {
  it("returns non-tracker names as-is", () => {
    expect(summarizeProcessNames(["infoservice.exe", "mobilebridge.exe"]))
      .toBe("infoservice.exe, mobilebridge.exe");
  });

  it("keeps a single tracker as-is", () => {
    expect(summarizeProcessNames(["Tracker(288)"]))
      .toBe("Tracker(288)");
  });

  it("collapses consecutive tracker IDs into ranges", () => {
    const names = ["Tracker(746)", "Tracker(747)", "Tracker(748)", "Tracker(749)"];
    expect(summarizeProcessNames(names)).toBe("4 Trackers (746–749)");
  });

  it("handles multiple non-consecutive ranges", () => {
    const names = [
      "Tracker(746)", "Tracker(747)", "Tracker(748)",
      "Tracker(858)", "Tracker(859)",
      "Tracker(900)",
    ];
    expect(summarizeProcessNames(names)).toBe("6 Trackers (746–748, 858–859, 900)");
  });

  it("mixes trackers and other processes", () => {
    const names = [
      "infoservice.exe", "mobilebridge.exe",
      "Tracker(746)", "Tracker(747)", "Tracker(748)",
    ];
    expect(summarizeProcessNames(names))
      .toBe("infoservice.exe, mobilebridge.exe, 3 Trackers (746–748)");
  });

  it("handles unsorted input", () => {
    const names = ["Tracker(900)", "Tracker(748)", "Tracker(746)", "Tracker(747)"];
    expect(summarizeProcessNames(names)).toBe("4 Trackers (746–748, 900)");
  });
});