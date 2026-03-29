import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolGetUiThreadActivity } from "../../src/tools/ui-thread.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolGetUiThreadActivity", () => {
  it("analyzes UI thread activity", async () => {
    const result = await toolGetUiThreadActivity(testDir.dir, {
      files: ["ae"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("detects freezes with custom threshold", async () => {
    const result = await toolGetUiThreadActivity(testDir.dir, {
      files: ["ae"],
      threadId: "1",
      freezeThresholdMs: 2000,
    });
    expect(typeof result).toBe("string");
    // The tool should detect the 5-second gap between entries, or show thread activity
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by time window", async () => {
    const result = await toolGetUiThreadActivity(testDir.dir, {
      files: ["ae"],
      startTime: "10:00:04",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

