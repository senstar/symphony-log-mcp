import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolInterServer } from "../../src/tools/interserver.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { INTERSERVER_LOG_CONTENT, ISOLATED_SERVER_LOG_CONTENT, INTERSERVER_MAP_NOISE_CONTENT } from "../fixtures.js";

let testDir: TestLogDir;
beforeEach(async () => {
  testDir = await createTestLogDir({ 'is-260301_00.txt': INTERSERVER_LOG_CONTENT });
});
afterEach(async () => { await testDir.cleanup(); });

describe("toolInterServer — summary mode", () => {
  it("detects ALIVE send events", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("INTER-SERVER COMMUNICATION SUMMARY");
    expect(result).toContain("alive send");
  });

  it("detects ALIVE receive events", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("alive recv");
  });

  it("detects ExecuteOnProxy failures", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("proxy fail");
  });

  it("detects ClientTerminated events", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("client term");
  });

  it("lists communication partners", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("5001");
    expect(result).toContain("5002");
  });

  it("reports total event count", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("Total events:");
  });
});

describe("toolInterServer — map mode", () => {
  it("builds server communication map", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "map", files: ["is"] });
    expect(result).toContain("SERVER COMMUNICATION MAP");
    expect(result).toContain("5001");
    expect(result).toContain("5002");
    expect(result).toContain("5003");
  });

  it("shows send/recv/fail counts", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "map", files: ["is"] });
    expect(result).toContain("sent:");
    expect(result).toContain("recv:");
    expect(result).toContain("fail:");
  });

  it("shows total peers", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "map", files: ["is"] });
    expect(result).toContain("Total peers:");
  });
});

describe("toolInterServer — failures mode", () => {
  it("lists failure events", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "failures", files: ["is"] });
    expect(result).toContain("5003");
    expect(result).toContain("ExecuteOnProxy");
  });

  it("includes ClientTerminated failures", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "failures", files: ["is"] });
    expect(result).toContain("ClientTerminated");
  });
});

describe("toolInterServer — asymmetric communication", () => {
  it("detects one-way communication (sends but no receives)", async () => {
    const dir = await createTestLogDir({ 'is-260303_00.txt': ISOLATED_SERVER_LOG_CONTENT });
    try {
      const result = await toolInterServer(dir.dir, { mode: "summary", files: ["is-260303_00.txt"] });
      expect(result).toContain("ASYMMETRY");
      expect(result).toContain("ISOLATED");
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toolInterServer — isolated server", () => {
  it("detects isolated server pattern in map mode", async () => {
    const dir = await createTestLogDir({ 'is-260303_00.txt': ISOLATED_SERVER_LOG_CONTENT });
    try {
      const result = await toolInterServer(dir.dir, { mode: "map", files: ["is-260303_00.txt"] });
      expect(result).toContain("SERVER COMMUNICATION MAP");
      expect(result).toContain("5001");
      expect(result).toContain("ONE-WAY");
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toolInterServer — noise filtering", () => {
  it("aggregates multiple client ports per IP", async () => {
    const dir = await createTestLogDir({ 'is-260303_00.txt': INTERSERVER_MAP_NOISE_CONTENT });
    try {
      const result = await toolInterServer(dir.dir, { mode: "map", files: ["is-260303_00.txt"] });
      expect(result).toContain("SERVER COMMUNICATION MAP");
      // Multiple ClientTerminated from 10.1.100.1 with different ports should be aggregated
      expect(result).toContain("client ports");
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toolInterServer — empty", () => {
  it("returns clean output when no interserver events", async () => {
    // SCCP logs have CPU stats, no interserver events
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["sccp"] });
    expect(result).toContain("No inter-server communication events found");
  });

  it("returns no-files message for nonexistent files", async () => {
    const result = await toolInterServer(testDir.dir, { mode: "summary", files: ["nonexistent-260101_00.txt"] });
    expect(result).toContain("No log files found");
  });
});
