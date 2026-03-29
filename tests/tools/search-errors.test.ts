import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeErrorGroups, toolSearchErrors } from "../../src/tools/search-errors.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("computeErrorGroups", () => {
  it("finds errors in IS logs", async () => {
    const { rawErrors, fileCount } = await computeErrorGroups(testDir.dir, {
      files: ["is"],
      deduplicate: false,
    });
    expect(rawErrors).toHaveLength(3);
    expect(fileCount).toBe(1);
  });

  it("deduplicates by fingerprint", async () => {
    const { groups } = await computeErrorGroups(testDir.dir, { files: ["is"] });
    expect(groups.size).toBe(2);
  });

  it("timeout group has count 2", async () => {
    const { groups } = await computeErrorGroups(testDir.dir, { files: ["is"] });
    const timeoutGroup = [...groups.values()].find(
      (g) => g.first.line.message.includes("TimeoutException")
    );
    expect(timeoutGroup).toBeDefined();
    expect(timeoutGroup!.count).toBe(2);
  });

  it("detects stack traces", async () => {
    const { groups } = await computeErrorGroups(testDir.dir, { files: ["is"] });
    const alarmsGroup = [...groups.values()].find(
      (g) => g.first.line.message.includes("alarms")
    );
    expect(alarmsGroup).toBeDefined();
    expect(alarmsGroup!.hasStack).toBe(true);
  });

  it("respects time window", async () => {
    const { groups } = await computeErrorGroups(testDir.dir, {
      files: ["is"],
      startTime: "10:00:07",
    });
    // Only the two TimeoutException errors at 10:00:08 and 10:00:09 remain
    expect(groups.size).toBe(1);
    const only = [...groups.values()][0];
    expect(only.count).toBe(2);
    expect(only.first.line.message).toContain("TimeoutException");
  });
});

describe("toolSearchErrors", () => {
  it("returns formatted output", async () => {
    const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
    expect(typeof result).toBe("string");
    expect(result).toContain("error pattern");
    expect(result).toContain("2");
  });

  it("includes stack traces when requested", async () => {
    const result = await toolSearchErrors(testDir.dir, {
      files: ["is"],
      includeStacks: true,
    });
    expect(result).toContain("AlarmProvider");
  });

  it("handles clean logs", async () => {
    const result = await toolSearchErrors(testDir.dir, { files: ["sccp"] });
    expect(result).toMatch(/no error/i);
  });
});

