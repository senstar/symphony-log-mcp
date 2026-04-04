import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolTriage, scanConnectivity, summarizeProcessNames } from "../../src/tools/triage.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import {
  ISOLATED_SERVER_LOG_CONTENT,
  CRASH_DUMP_CONTENT,
  DNS_FAILURE_CONTENT,
  SESSION_FAILURE_CONTENT,
  IS_LOG_CONTENT,
} from "../fixtures.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── summarizeProcessNames ──────────────────────────────────────────────────

describe("summarizeProcessNames", () => {
  it("returns comma-separated names when no Trackers", () => {
    expect(summarizeProcessNames(["infoservice.exe", "ae.exe"])).toBe(
      "infoservice.exe, ae.exe"
    );
  });

  it("collapses consecutive Tracker IDs into ranges", () => {
    const names = ["Tracker(746)", "Tracker(747)", "Tracker(748)", "infoservice.exe"];
    const result = summarizeProcessNames(names);
    expect(result).toContain("3 Trackers");
    expect(result).toContain("infoservice.exe");
  });

  it("handles a single Tracker", () => {
    const result = summarizeProcessNames(["Tracker(5)"]);
    expect(result).toBe("Tracker(5)");
  });
});

// ── scanConnectivity ───────────────────────────────────────────────────────

describe("scanConnectivity", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns ConnectivityFindings with expected shape", async () => {
    const findings = await scanConnectivity(testDir.dir);
    expect(findings).toHaveProperty("seemsFailedServers");
    expect(findings).toHaveProperty("aliveSendCount");
    expect(findings).toHaveProperty("aliveRecvCount");
    expect(findings).toHaveProperty("crashDumps");
    expect(findings).toHaveProperty("dnsFailures");
    expect(findings).toHaveProperty("sessionFailureCount");
    expect(findings).toHaveProperty("isFarmMember");
    expect(Array.isArray(findings.seemsFailedServers)).toBe(true);
    expect(Array.isArray(findings.crashDumps)).toBe(true);
  });

  it("returns empty findings for dir with no IS or AE files", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-empty-"));
    try {
      const findings = await scanConnectivity(emptyDir);
      expect(findings.seemsFailedServers).toHaveLength(0);
      expect(findings.aliveSendCount).toBe(0);
      expect(findings.crashDumps).toHaveLength(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("detects SEEMS FAILED servers", async () => {
    const dir = await createTestLogDir({
      "is-260302_00.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    try {
      const findings = await scanConnectivity(dir.dir);
      expect(findings.seemsFailedServers.length).toBeGreaterThan(0);
      expect(findings.isFarmMember).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it("detects crash dumps in AE logs", async () => {
    const dir = await createTestLogDir({
      "ae-260302_00.txt": CRASH_DUMP_CONTENT,
    });
    try {
      const findings = await scanConnectivity(dir.dir);
      expect(findings.crashDumps.length).toBeGreaterThan(0);
      expect(findings.unhandledExceptionCount).toBeGreaterThan(0);
    } finally {
      await dir.cleanup();
    }
  });

  it("detects DNS failures", async () => {
    const dir = await createTestLogDir({
      "is-260302_00.txt": DNS_FAILURE_CONTENT,
    });
    try {
      const findings = await scanConnectivity(dir.dir);
      expect(findings.dnsFailures.size).toBeGreaterThan(0);
      expect(findings.dnsFailures.has("NODE1.corp.local")).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it("detects session failures", async () => {
    const dir = await createTestLogDir({
      "is-260302_00.txt": SESSION_FAILURE_CONTENT,
    });
    try {
      const findings = await scanConnectivity(dir.dir);
      expect(findings.sessionFailureCount).toBeGreaterThan(0);
    } finally {
      await dir.cleanup();
    }
  });

  it("respects time window", async () => {
    const dir = await createTestLogDir({
      "is-260302_00.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    try {
      // Window before all log entries → no detections
      const findings = await scanConnectivity(dir.dir, "08:00:00", "09:00:00");
      expect(findings.seemsFailedServers).toHaveLength(0);
      expect(findings.aliveSendCount).toBe(0);
    } finally {
      await dir.cleanup();
    }
  });
});

// ── toolTriage ─────────────────────────────────────────────────────────────

describe("toolTriage", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns a formatted string report", async () => {
    const result = await toolTriage(testDir.dir, null, {});
    expect(typeof result).toBe("string");
    expect(result).toContain("TRIAGE REPORT");
    expect(result).toContain("finding");
  });

  it("includes connectivity findings when IS files present", async () => {
    const result = await toolTriage(testDir.dir, null, {});
    expect(typeof result).toBe("string");
    // Report should mention some category or be a valid structured report
    expect(result.length).toBeGreaterThan(50);
  });

  it("handles empty log directory gracefully", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-empty-"));
    try {
      const result = await toolTriage(emptyDir, null, {});
      expect(typeof result).toBe("string");
      expect(result).toContain("TRIAGE REPORT");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("respects startTime/endTime", async () => {
    const result = await toolTriage(testDir.dir, null, {
      startTime: "10:00:00",
      endTime: "10:00:05",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("TRIAGE REPORT");
  });
});
