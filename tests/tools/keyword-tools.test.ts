import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolVideoHealth } from "../../src/tools/video-health.js";
import { toolStorage } from "../../src/tools/storage.js";
import { toolAlarms } from "../../src/tools/alarms.js";
import { toolNetwork } from "../../src/tools/network.js";
import { toolAccessControl } from "../../src/tools/access-control.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolVideoHealth", () => {
  it("analyzes video logs", async () => {
    const result = await toolVideoHealth(testDir.dir, {
      files: ["cs01"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolStorage", () => {
  it("analyzes storage logs", async () => {
    const result = await toolStorage(testDir.dir, {
      files: ["sccl"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolAlarms", () => {
  it("analyzes alarm logs", async () => {
    const result = await toolAlarms(testDir.dir, {
      files: ["scac"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolNetwork", () => {
  it("analyzes network logs", async () => {
    const result = await toolNetwork(testDir.dir, {
      files: ["hm"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolAccessControl", () => {
  it("analyzes access control logs", async () => {
    const result = await toolAccessControl(testDir.dir, {
      files: ["ac"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

