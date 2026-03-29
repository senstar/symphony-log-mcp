/**
 * Tests for new analysis tools: auth, db-health, cameras, interserver, hw, farm-summary
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { toolAuth } from "../../src/tools/auth-analysis.js";
import { toolDbHealth } from "../../src/tools/db-health.js";
import { toolCameras } from "../../src/tools/camera-analysis.js";
import { toolInterServer } from "../../src/tools/interserver.js";
import { toolHw } from "../../src/tools/hw-analysis.js";
import { toolFarmSummary } from "../../src/tools/farm-summary.js";
import {
  AUTH_LOG_CONTENT,
  DB_HEALTH_LOG_CONTENT,
  INTERSERVER_LOG_CONTENT,
  HW_LOG_CONTENT,
  CAMERA_TRACKER_LOG_CONTENT,
  CAMERA_VIDCAPS_CONTENT,
  SCCP_LOG_CONTENT,
  IS_LOG_CONTENT,
} from "../fixtures.js";

// ── Auth Analysis ────────────────────────────────────────────────────────────

describe("toolAuth", () => {
  let testDir: TestLogDir;

  beforeEach(async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": AUTH_LOG_CONTENT,
    });
  });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns summary with category counts", async () => {
    const result = await toolAuth(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("AUTHENTICATION");
    expect(result).toContain("ad failure");
  });

  it("returns failures list", async () => {
    const result = await toolAuth(testDir.dir, {
      mode: "failures",
      files: ["is"],
    });
    expect(result).toContain("failure");
  });

  it("returns sessions with login/logout", async () => {
    const result = await toolAuth(testDir.dir, {
      mode: "sessions",
      files: ["is"],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by username", async () => {
    const result = await toolAuth(testDir.dir, {
      mode: "failures",
      files: ["is"],
      userFilter: "admin",
    });
    expect(result).toContain("admin");
  });

  it("returns no-data message when no auth events", async () => {
    const result = await toolAuth(testDir.dir, {
      mode: "summary",
      files: ["sccp"],
    });
    expect(result.toLowerCase()).toMatch(/no auth|no log/i);
  });
});

// ── DB Health ────────────────────────────────────────────────────────────────

describe("toolDbHealth", () => {
  let testDir: TestLogDir;

  beforeEach(async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": DB_HEALTH_LOG_CONTENT,
    });
  });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns summary with event categories", async () => {
    const result = await toolDbHealth(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("DATABASE");
    expect(result).toMatch(/connection.failure|sql.error|pool|timeout/i);
  });

  it("detects outage windows from failure bursts", async () => {
    const result = await toolDbHealth(testDir.dir, {
      mode: "outages",
      files: ["is"],
    });
    expect(result).toMatch(/outage|window|11:44/i);
  });

  it("lists events chronologically", async () => {
    const result = await toolDbHealth(testDir.dir, {
      mode: "events",
      files: ["is"],
    });
    expect(result).toContain("11:44");
  });

  it("returns no-data message when no DB events", async () => {
    const result = await toolDbHealth(testDir.dir, {
      mode: "summary",
      files: ["sccp"],
    });
    expect(result.toLowerCase()).toMatch(/no database|no log/i);
  });
});

// ── Camera Analysis ──────────────────────────────────────────────────────────

describe("toolCameras", () => {
  let testDir: TestLogDir;

  beforeEach(async () => {
    testDir = await createTestLogDir({
      "cs05-260302_00.txt": CAMERA_TRACKER_LOG_CONTENT,
      "cs05_vidcaps.txt": CAMERA_VIDCAPS_CONTENT,
      "cs12-260302_00.txt": CAMERA_TRACKER_LOG_CONTENT,
    });
  });
  afterEach(async () => { await testDir.cleanup(); });

  it("discovers cameras from vidcaps and tracker files", async () => {
    const result = await toolCameras(testDir.dir, { mode: "inventory" });
    expect(result).toContain("CAMERA INVENTORY");
    expect(result).toMatch(/vidcaps/i);
  });

  it("reports camera problems", async () => {
    const result = await toolCameras(testDir.dir, { mode: "problems" });
    expect(result).toContain("CAMERA PROBLEMS");
  });

  it("shows camera status overview", async () => {
    const result = await toolCameras(testDir.dir, { mode: "status" });
    expect(result).toContain("CAMERA STATUS");
  });

  it("filters by camera ID", async () => {
    const result = await toolCameras(testDir.dir, {
      mode: "inventory",
      cameraFilter: "5",
    });
    expect(typeof result).toBe("string");
  });

  it("returns no-cameras message for empty dir", async () => {
    const emptyDir = path.join(testDir.dir, "empty");
    await fs.mkdir(emptyDir);
    const result = await toolCameras(emptyDir, { mode: "inventory" });
    expect(result.toLowerCase()).toContain("no camera");
  });
});

// ── Inter-Server Analysis ────────────────────────────────────────────────────

describe("toolInterServer", () => {
  let testDir: TestLogDir;

  beforeEach(async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": INTERSERVER_LOG_CONTENT,
    });
  });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns communication summary", async () => {
    const result = await toolInterServer(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("INTER-SERVER");
    expect(result).toMatch(/alive|proxy|conn/i);
  });

  it("builds a communication map", async () => {
    const result = await toolInterServer(testDir.dir, {
      mode: "map",
      files: ["is"],
    });
    expect(result).toContain("COMMUNICATION MAP");
    expect(result).toMatch(/5001|5002|5003/);
  });

  it("lists failures", async () => {
    const result = await toolInterServer(testDir.dir, {
      mode: "failures",
      files: ["is"],
    });
    expect(result).toMatch(/failure|proxy_fail|conn_fail|client_term/i);
  });

  it("filters by server ID", async () => {
    const result = await toolInterServer(testDir.dir, {
      mode: "failures",
      files: ["is"],
      serverFilter: "5003",
    });
    expect(result).toContain("5003");
  });

  it("returns no-data on empty log", async () => {
    const result = await toolInterServer(testDir.dir, {
      mode: "summary",
      files: ["sccp"],
    });
    expect(result.toLowerCase()).toContain("no inter-server");
  });
});

// ── Hardware Analysis ────────────────────────────────────────────────────────

describe("toolHw", () => {
  let testDir: TestLogDir;

  beforeEach(async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HW_LOG_CONTENT,
    });
  });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns hardware summary", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("HARDWARE");
    expect(result).toMatch(/advantech|serial|door|io.module|connection|error/i);
  });

  it("shows Advantech events", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "advantech",
      files: ["is"],
    });
    expect(result).toMatch(/Advantech|ADAM/i);
  });

  it("builds device inventory", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "devices",
      files: ["is"],
    });
    expect(result).toContain("DEVICE INVENTORY");
  });

  it("lists hardware errors", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "errors",
      files: ["is"],
    });
    expect(result).toMatch(/hardware error|error/i);
  });

  it("filters by device", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "summary",
      files: ["is"],
      deviceFilter: "COM3",
    });
    expect(typeof result).toBe("string");
  });

  it("returns no-data on clean log", async () => {
    const result = await toolHw(testDir.dir, {
      mode: "summary",
      files: ["sccp"],
    });
    expect(result.toLowerCase()).toContain("no hardware");
  });
});

// ── Farm Summary ─────────────────────────────────────────────────────────────

describe("toolFarmSummary", () => {
  let parentDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    // Create a parent dir with two mock server packages, each with a Log/ subdirectory
    const os = await import("os");
    parentDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "sym-farm-"));

    const server1Dir = path.join(parentDir, "SymphonyLog-server1");
    const server1Log = path.join(server1Dir, "Log");
    await fs.mkdir(server1Log, { recursive: true });
    await fs.writeFile(path.join(server1Log, "is-260302_00.txt"), IS_LOG_CONTENT);
    await fs.writeFile(path.join(server1Log, "sccp-260302_00.txt"), SCCP_LOG_CONTENT);

    const server2Dir = path.join(parentDir, "SymphonyLog-server2");
    const server2Log = path.join(server2Dir, "Log");
    await fs.mkdir(server2Log, { recursive: true });
    await fs.writeFile(path.join(server2Log, "is-260302_00.txt"), IS_LOG_CONTENT);
    await fs.writeFile(path.join(server2Log, "sccp-260302_00.txt"), SCCP_LOG_CONTENT);

    cleanup = async () => {
      await fs.rm(parentDir, { recursive: true, force: true });
    };
  });
  afterEach(async () => { await cleanup(); });

  it("produces a dashboard for multiple servers", async () => {
    const result = await toolFarmSummary("", {
      parentDir,
      mode: "dashboard",
    });
    expect(result).toContain("FARM DASHBOARD");
    expect(result).toMatch(/server1|server2/i);
  });

  it("aggregates errors across servers", async () => {
    const result = await toolFarmSummary("", {
      parentDir,
      mode: "errors",
    });
    expect(result).toContain("ERROR");
  });

  it("shows topology", async () => {
    const result = await toolFarmSummary("", {
      parentDir,
      mode: "topology",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles empty parent directory gracefully", async () => {
    const emptyDir = path.join(parentDir, "empty_farm");
    await fs.mkdir(emptyDir);
    const result = await toolFarmSummary("", {
      parentDir: emptyDir,
      mode: "dashboard",
    });
    expect(result.toLowerCase()).toMatch(/no server|0/);
  });
});
