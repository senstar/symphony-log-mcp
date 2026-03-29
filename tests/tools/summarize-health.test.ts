import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolSummarizeHealth, toolMemoryTrends } from "../../src/tools/summarize-health.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolSummarizeHealth", () => {
  it("produces health summary", async () => {
    const result = await toolSummarizeHealth(testDir.dir, { sccpFiles: ["sccp"] });
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("includes health rating", async () => {
    const result = await toolSummarizeHealth(testDir.dir, { sccpFiles: ["sccp"] });
    const lower = result.toLowerCase();
    expect(lower).toMatch(/health/);
  });

  it("includes error context when provided", async () => {
    const withoutErrors = await toolSummarizeHealth(testDir.dir, { sccpFiles: ["sccp"] });
    const withErrors = await toolSummarizeHealth(testDir.dir, {
      sccpFiles: ["sccp"],
      errorFiles: ["is"],
    });
    expect(withErrors).toBeTruthy();
    // With error files should mention errors or produce more output
    expect(withErrors.length).toBeGreaterThanOrEqual(withoutErrors.length);
  });
});

describe("toolMemoryTrends", () => {
  it("analyzes memory trends", async () => {
    const result = await toolMemoryTrends(testDir.dir, { sccpFiles: ["sccp"] });
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns message when no matching data", async () => {
    const result = await toolMemoryTrends(testDir.dir, {
      sccpFiles: ["sccp"],
      filter: "nonexistent",
    });
    expect(result.toLowerCase()).toMatch(/no.*data|no.*found|no.*process/);
  });
});

