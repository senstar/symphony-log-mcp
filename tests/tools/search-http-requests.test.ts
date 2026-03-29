import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolSearchHttpRequests } from "../../src/tools/search-http-requests.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolSearchHttpRequests", () => {
  it("finds HTTP requests", async () => {
    const result = await toolSearchHttpRequests(testDir.dir, {
      files: ["is"],
      mode: "requests",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters slow requests", async () => {
    const result = await toolSearchHttpRequests(testDir.dir, {
      files: ["is"],
      mode: "slow",
      minDurationMs: 1000,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("alarms");
  });

  it("shows rates", async () => {
    const result = await toolSearchHttpRequests(testDir.dir, {
      files: ["is"],
      mode: "rates",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("shows totals", async () => {
    const result = await toolSearchHttpRequests(testDir.dir, {
      files: ["is"],
      mode: "totals",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

