import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolGetServiceLifecycle, toolDetectLogGaps } from "../../src/tools/service-lifecycle.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolGetServiceLifecycle", () => {
  it("detects service lifecycle events", async () => {
    const result = await toolGetServiceLifecycle(testDir.dir, { files: ["sc"] });
    expect(result).toBeTruthy();
    expect(result.toLowerCase()).toMatch(/start|stop/);
  });

  it("filters by time window", async () => {
    const result = await toolGetServiceLifecycle(testDir.dir, {
      files: ["sc"],
      startTime: "10:30:00",
    });
    expect(result).toBeTruthy();
    expect(result.toLowerCase()).toMatch(/start|stop/);
  });
});

describe("toolDetectLogGaps", () => {
  it("detects gaps in logging", async () => {
    const result = await toolDetectLogGaps(testDir.dir, {
      files: ["sc"],
      gapThresholdSec: 60,
    });
    expect(result).toBeTruthy();
    // 30-minute gap from 10:00:01 to 10:30:00 should be detected
    expect(result.toLowerCase()).toMatch(/gap/);
  });

  it("handles no-gap scenario", async () => {
    const result = await toolDetectLogGaps(testDir.dir, {
      files: ["is"],
      gapThresholdSec: 99999,
    });
    expect(result.toLowerCase()).toMatch(/no.*gap/);
  });
});

