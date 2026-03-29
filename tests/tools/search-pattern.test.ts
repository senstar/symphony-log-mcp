import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolSearchPattern, toolSearchCount, toolSearchAssertAbsent } from "../../src/tools/search-pattern.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolSearchPattern", () => {
  it("finds plain text matches", async () => {
    const result = await toolSearchPattern(testDir.dir, {
      files: ["is"],
      pattern: "cameras",
    });
    expect(result).toContain("cameras");
  });

  it("supports regex patterns", async () => {
    const result = await toolSearchPattern(testDir.dir, {
      files: ["is"],
      pattern: "status=\\d+",
      isRegex: true,
    });
    expect(result).toContain("status=");
  });

  it("filters by level", async () => {
    const result = await toolSearchPattern(testDir.dir, {
      files: ["is"],
      pattern: "timed out",
      levelFilter: ["Error"],
    });
    expect(result).toContain("TimeoutException");
  });

  it("handles invalid regex", async () => {
    const result = await toolSearchPattern(testDir.dir, {
      files: ["is"],
      pattern: "[invalid",
      isRegex: true,
    });
    expect(result).toMatch(/invalid/i);
  });

  it("supports context lines", async () => {
    const result = await toolSearchPattern(testDir.dir, {
      files: ["is"],
      pattern: "alarms",
      contextLines: 1,
    });
    expect(result).toContain("alarms");
  });
});

describe("toolSearchCount", () => {
  it("counts pattern occurrences", async () => {
    const result = await toolSearchCount(testDir.dir, {
      files: ["is"],
      pattern: "status=200",
    });
    expect(result).toContain("2");
  });

  it("returns table format", async () => {
    const result = await toolSearchCount(testDir.dir, {
      files: ["is"],
      pattern: "status=200",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolSearchAssertAbsent", () => {
  it("confirms absence", async () => {
    const result = await toolSearchAssertAbsent(testDir.dir, {
      files: ["is"],
      pattern: "NONEXISTENT_STRING_XYZ",
    });
    expect(result).toMatch(/confirmed absent|not found|0 match/i);
  });

  it("reports unexpected matches", async () => {
    const result = await toolSearchAssertAbsent(testDir.dir, {
      files: ["is"],
      pattern: "cameras",
    });
    expect(result).toContain("cameras");
  });
});

