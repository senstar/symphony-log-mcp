import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolCorrelateTimelines, toolWaveAnalysis } from "../../src/tools/correlate-timeline.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolCorrelateTimelines", () => {
  it("merges entries from multiple files", async () => {
    const result = await toolCorrelateTimelines(testDir.dir, {
      files: ["is", "sc"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by level", async () => {
    const result = await toolCorrelateTimelines(testDir.dir, {
      files: ["is"],
      levelFilter: ["Error"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolWaveAnalysis", () => {
  it("groups pattern matches into waves", async () => {
    const result = await toolWaveAnalysis(testDir.dir, {
      files: ["sc"],
      pattern: "Service",
      gapSeconds: 60,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles no matches", async () => {
    const result = await toolWaveAnalysis(testDir.dir, {
      files: ["is"],
      pattern: "NONEXISTENT_PATTERN_XYZ",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

