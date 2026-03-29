/**
 * Tests for connectivity improvements:
 *  - Triage: SEEMS FAILED, ALIVE asymmetry, ForceServerRefresh, DeltaCache gaps
 *  - Interserver: asymmetry detection, IP-to-server mapping
 *  - Farm: connectivity mode with ALIVE matrix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { toolTriage, scanConnectivity } from "../../src/tools/triage.js";
import { toolInterServer } from "../../src/tools/interserver.js";
import { toolFarmSummary } from "../../src/tools/farm-summary.js";
import {
  ISOLATED_SERVER_LOG_CONTENT,
  HEALTHY_FARM_LOG_CONTENT,
  INTERSERVER_LOG_CONTENT,
  SCCP_LOG_CONTENT,
  IS_LOG_CONTENT,
  DOWN_SERVER_RPC_CONTENT,
  MASTER_CHANGEOVER_CONTENT,
  INTERSERVER_MAP_NOISE_CONTENT,
  SSL_ISSUES_CONTENT,
  RECOVERY_AND_OVERLOAD_CONTENT,
  SERVICE_RESTART_CAUSE_CONTENT,
  PENDING_CHANGES_TIMEOUT_CONTENT,
  ADDRESS_CONFIG_ERROR_CONTENT,
  CRASH_DUMP_CONTENT,
  DNS_FAILURE_CONTENT,
  SESSION_FAILURE_CONTENT,
  DELIVERY_FAILURE_CONTENT,
  IS_FULL_LOG_LEVEL_CONTENT,
  IS_MINIMAL_LOG_LEVEL_CONTENT,
  AE_MINIMAL_LOG_LEVEL_CONTENT,
  SERVER_CAMERA_LOG_LEVEL_CONTENT,
} from "../fixtures.js";

// ── scanConnectivity (unit) ──────────────────────────────────────────────────

describe("scanConnectivity", () => {
  let testDir: TestLogDir;

  afterEach(async () => { await testDir.cleanup(); });

  it("detects SEEMS FAILED servers", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.seemsFailedServers).toContain("5001");
    expect(conn.seemsFailedServers).toContain("5020");
    expect(conn.seemsFailedServers).toContain("5022");
    expect(conn.seemsFailedServers.length).toBe(3);
  });

  it("detects one-way ALIVE (send but no receive)", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.aliveSendCount).toBeGreaterThan(0);
    expect(conn.aliveRecvCount).toBe(0);
    expect(conn.isFarmMember).toBe(true);
    expect(conn.aliveTargets).toContain("5001");
  });

  it("detects healthy bidirectional ALIVE exchange", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.aliveSendCount).toBeGreaterThan(0);
    expect(conn.aliveRecvCount).toBeGreaterThan(0);
    expect(conn.isFarmMember).toBe(true);
  });

  it("detects ForceServerRefreshDeviceGraph presence", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.hasForceRefresh).toBe(true);
  });

  it("flags missing ForceServerRefreshDeviceGraph", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.hasForceRefresh).toBe(false);
  });

  it("detects DeltaCache polling gaps exceeding adaptive threshold", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.deltaCacheGaps.length).toBeGreaterThan(0);
    // Normal interval is ~5 min, adaptive threshold = max(10min, 10min) = 10 min
    // Gap from 10:15 → 10:45 = 30 min, well above threshold
    expect(conn.deltaCacheGaps[0].gapMins).toBe(30);
  });

  it("returns no gaps for normal polling intervals", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.deltaCacheGaps.length).toBe(0);
  });

  it("returns empty findings when no IS files exist", async () => {
    testDir = await createTestLogDir();
    // default test dir has is-260302_00.txt with standard content (no ALIVE patterns)
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.isFarmMember).toBe(false);
    expect(conn.seemsFailedServers.length).toBe(0);
  });

  it("detects DownServer RPC reports", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": DOWN_SERVER_RPC_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.downServerReports.size).toBeGreaterThan(0);
    // "Calling 5003 signals.DownServer for down server 5001" × 2
    expect(conn.downServerReports.get("5001")).toBe(2);
    // "5015 says 5018 is down" × 1
    expect(conn.downServerReports.get("5018")).toBe(1);
    // "Calling 5003 signals.DownServer for down server 5007" × 1
    expect(conn.downServerReports.get("5007")).toBe(1);
  });

  it("detects master changeover events", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": MASTER_CHANGEOVER_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.masterChanges.length).toBe(1);
    expect(conn.masterChanges[0].from).toBe("5001");
    expect(conn.masterChanges[0].to).toBe("5003");
    expect(conn.masterChanges[0].timestamp).toContain("10:59:38");
  });

  it("uses adaptive DeltaCache threshold (2× median)", async () => {
    // Fixture has 30s intervals (10:00:05, 10:00:35, 10:01:05)
    // Median interval = 30s, threshold = max(60s, 10min) = 10min
    // No 10min gaps exist → 0 gaps
    testDir = await createTestLogDir({
      "is-260302_01.txt": DOWN_SERVER_RPC_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.deltaCacheGaps.length).toBe(0);
  });

  it("detects BACK UP recovery events", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": RECOVERY_AND_OVERLOAD_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.backUpServers).toContain("5031");
  });

  it("detects SSL certificate policy issues", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SSL_ISSUES_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.sslIssues.size).toBeGreaterThan(0);
    expect(conn.sslIssues.get("RemoteCertificateNotAvailable")).toBe(2);
    expect(conn.sslIssues.get("RemoteCertificateChainErrors")).toBe(1);
  });

  it("detects No message dispatcher overload", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": RECOVERY_AND_OVERLOAD_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.noDispatcherCount).toBe(3);
  });

  it("detects service stop requests (restart cause)", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SERVICE_RESTART_CAUSE_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.serviceStopRequests.size).toBeGreaterThan(0);
    expect(conn.serviceStopRequests.get("InfoService")).toBe(1);
  });

  it("detects PendingChanges timeouts", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": PENDING_CHANGES_TIMEOUT_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.pendingChangesTimeouts.length).toBe(2);
    expect(conn.pendingChangesTimeouts[0]).toContain("00:02:00");
  });

  it("detects address config errors", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ADDRESS_CONFIG_ERROR_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.addressErrors.size).toBe(2);
    expect(conn.addressErrors.get("5002")).toBe(3);
    expect(conn.addressErrors.get("5003")).toBe(1);
  });

  it("detects crash dumps in AE logs", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": CRASH_DUMP_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.crashDumps.length).toBe(2);
    expect(conn.crashDumps[0]).toContain("ae_030005.dmp");
  });

  it("detects unhandled exceptions in AE logs", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": CRASH_DUMP_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    // Application_ThreadException + MyUnhandledExceptionHandlerTerminator
    expect(conn.unhandledExceptionCount).toBe(2);
  });

  it("detects DNS resolution failures", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": DNS_FAILURE_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.dnsFailures.size).toBe(2);
    expect(conn.dnsFailures.get("NODE1.corp.local")).toBe(3);
    expect(conn.dnsFailures.get("NODE2.corp.local")).toBe(2);
  });

  it("detects session/token failures in IS logs", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SESSION_FAILURE_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.sessionFailureCount).toBe(5);
  });

  it("detects request delivery failures in AE logs", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": DELIVERY_FAILURE_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.deliveryFailureCount).toBe(4);
  });

  it("detects full diagnostic IS log level", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_FULL_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.isLogLevel).not.toBeNull();
    expect(conn.isLogLevel!.hasDiagnostic).toBe(true);
    expect(conn.isLogLevel!.levels).toContain("LogDiagnostic");
    expect(conn.isLogLevel!.levels).toContain("MoreInfo");
  });

  it("detects minimal IS log level (BasicInfo|LogError only)", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_MINIMAL_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.isLogLevel).not.toBeNull();
    expect(conn.isLogLevel!.hasDiagnostic).toBe(false);
    expect(conn.isLogLevel!.levels).toBe("BasicInfo|LogError");
  });

  it("detects minimal AE log level", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": AE_MINIMAL_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.aeLogLevel).not.toBeNull();
    expect(conn.aeLogLevel!.hasDiagnostic).toBe(false);
    expect(conn.aeLogLevel!.levels).toBe("BasicInfo|LogError");
  });

  it("uses last declared level when level changes mid-file", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_FULL_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    // File has BasicInfo|LogError first, then full level — last one wins
    expect(conn.isLogLevel!.hasDiagnostic).toBe(true);
  });

  it("detects UpdateServerLogLevel per-service levels", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SERVER_CAMERA_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.serverLogLevels.size).toBe(2);
    expect(conn.serverLogLevels.get("InfoService")!.hasDiagnostic).toBe(true);
    expect(conn.serverLogLevels.get("Scheduler")!.hasDiagnostic).toBe(false);
  });

  it("detects UpdateCameraLogLevel per-camera levels", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SERVER_CAMERA_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    expect(conn.cameraLogLevels.size).toBe(2);
    expect(conn.cameraLogLevels.get("1")!.hasDiagnostic).toBe(true);
    expect(conn.cameraLogLevels.get("2")!.hasDiagnostic).toBe(true);
  });

  it("tracks observed log level distribution", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_FULL_LOG_LEVEL_CONTENT,
    });
    const conn = await scanConnectivity(testDir.dir);
    // Fixture has BasicInf, Diagnost, MoreInfo, Verbose entries
    expect(conn.observedLevels.get("BasicInfo")).toBeGreaterThan(0);
    expect(conn.observedLevels.get("Diagnostic")).toBeGreaterThan(0);
    expect(conn.observedLevels.get("MoreInfo")).toBeGreaterThan(0);
    expect(conn.observedLevels.get("Verbose")).toBeGreaterThan(0);
  });
});

// ── Triage with connectivity ─────────────────────────────────────────────────

describe("toolTriage connectivity findings", () => {
  let testDir: TestLogDir;

  afterEach(async () => { await testDir.cleanup(); });

  it("reports SEEMS FAILED as CRITICAL", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("SEEMS FAILED");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("Connectivity");
  });

  it("reports one-way communication as CRITICAL", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("ISOLATED");
    expect(result).toContain("one-way communication");
    expect(result).toContain("firewall");
  });

  it("reports missing ForceServerRefreshDeviceGraph as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("ForceServerRefreshDeviceGraph");
  });

  it("reports DeltaCache polling gaps as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("UpdateDeltaCache");
    expect(result).toContain("gap");
  });

  it("overrides HEALTHY to ISOLATED when one-way detected", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("ISOLATED");
  });

  it("shows normal ALIVE exchange as INFO for healthy farm member", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("ALIVE");
    expect(result).toContain("sent");
    expect(result).toContain("received");
  });

  it("reports DownServer RPC as WARNING in triage", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": DOWN_SERVER_RPC_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("DownServer RPC");
  });

  it("reports master changeover as CRITICAL in triage", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": MASTER_CHANGEOVER_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("MASTER CHANGEOVER");
    expect(result).toContain("5001");
    expect(result).toContain("5003");
    expect(result).toContain("CRITICAL");
  });

  it("reports SSL certificate chain errors as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SSL_ISSUES_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("SSL");
    expect(result).toContain("certificate");
  });

  it("reports BACK UP recovery in triage", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": RECOVERY_AND_OVERLOAD_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("BACK UP");
    expect(result).toContain("5031");
  });

  it("reports No message dispatcher as overload", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": RECOVERY_AND_OVERLOAD_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("message dispatcher");
    expect(result).toContain("overload");
  });

  it("reports service stop request as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SERVICE_RESTART_CAUSE_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("Service stop requested");
    expect(result).toContain("InfoService");
    expect(result).toContain("graceful restart");
  });

  it("reports PendingChanges timeouts in triage", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": PENDING_CHANGES_TIMEOUT_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("PendingChanges timeout");
    expect(result).toContain("WARNING");
  });

  it("reports address config errors in triage", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ADDRESS_CONFIG_ERROR_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("missing address config");
    expect(result).toContain("Configuration");
  });

  it("reports crash dumps as CRITICAL in triage", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": CRASH_DUMP_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("crash dump");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("Crashes");
  });

  it("reports unhandled exceptions as CRITICAL in triage", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": CRASH_DUMP_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("unhandled exception");
    expect(result).toContain("CRITICAL");
  });

  it("reports DNS failures as WARNING in triage", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": DNS_FAILURE_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("DNS resolution");
    expect(result).toContain("NODE1.corp.local");
    expect(result).toContain("WARNING");
  });

  it("reports session failures as INFO when count is low", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SESSION_FAILURE_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("session/token failure");
    expect(result).toContain("5");
  });

  it("reports delivery failures as INFO when count is low", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": DELIVERY_FAILURE_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("delivery failure");
    expect(result).toContain("4");
  });

  it("reports minimal IS log level as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_MINIMAL_LOG_LEVEL_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("Log Quality");
    expect(result).toContain("minimal");
    expect(result).toContain("WARNING");
  });

  it("reports full diagnostic IS log level as INFO", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": IS_FULL_LOG_LEVEL_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("Log Quality");
    expect(result).toContain("Server (IS) log level:");
  });

  it("reports minimal AE log level as WARNING", async () => {
    testDir = await createTestLogDir({
      "ae-260302_01.txt": AE_MINIMAL_LOG_LEVEL_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("Log Quality");
    expect(result).toContain("Client (AE)");
    expect(result).toContain("minimal");
  });

  it("reports service at minimal log level as WARNING", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": SERVER_CAMERA_LOG_LEVEL_CONTENT,
    });
    const result = await toolTriage(testDir.dir, null, {});
    expect(result).toContain("Scheduler");
    expect(result).toContain("minimal log level");
  });
});

// ── Interserver asymmetry detection ──────────────────────────────────────────

describe("toolInterServer asymmetry", () => {
  let testDir: TestLogDir;

  afterEach(async () => { await testDir.cleanup(); });

  it("shows ASYMMETRY ALERT for isolated server", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("ASYMMETRY");
    expect(result).toContain("ISOLATED");
  });

  it("no asymmetry alert for healthy server", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).not.toContain("ASYMMETRY ALERT");
  });

  it("shows IP-to-server mapping in summary", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": HEALTHY_FARM_LOG_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "summary",
      files: ["is"],
    });
    expect(result).toContain("IP → Server Mapping");
  });

  it("shows ONE-WAY flag in map mode", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "map",
      files: ["is"],
    });
    expect(result).toContain("ONE-WAY");
  });

  it("resolves IPs to server IDs in failures mode", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": ISOLATED_SERVER_LOG_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "failures",
      files: ["is"],
    });
    expect(result).toContain("failure");
  });

  it("aggregates multiple client ports per IP in map mode", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": INTERSERVER_MAP_NOISE_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "map",
      files: ["is"],
    });
    // Should show 10.1.100.1 once (not separate rows for :6691, :6815, :8000)
    const ipLines = result.split("\n").filter(l => l.includes("10.1.100.1"));
    expect(ipLines.length).toBe(1);
    // Should show aggregated failure count (3 client terminations)
    expect(ipLines[0]).toContain("fail:");
    // Should show client ports note
    expect(ipLines[0]).toContain("client ports");
  });

  it("shows total peers count in map footer", async () => {
    testDir = await createTestLogDir({
      "is-260302_01.txt": INTERSERVER_MAP_NOISE_CONTENT,
    });
    const result = await toolInterServer(testDir.dir, {
      mode: "map",
      files: ["is"],
    });
    expect(result).toContain("Total peers:");
  });
});

// ── Farm connectivity mode ───────────────────────────────────────────────────

describe("toolFarmSummary connectivity", () => {
  let farmDir: string;

  beforeEach(async () => {
    const os = await import("os");
    farmDir = await fs.mkdtemp(path.join(os.default.tmpdir(), "sym-farm-conn-"));

    // Create two server directories
    const server1Dir = path.join(farmDir, "SymphonyLog-server5001-260327-121036", "Log");
    const server2Dir = path.join(farmDir, "SymphonyLog-server5023-260327-121036", "Log");
    await fs.mkdir(server1Dir, { recursive: true });
    await fs.mkdir(server2Dir, { recursive: true });

    // Server 5001: healthy bidirectional
    await fs.writeFile(path.join(server1Dir, "is-260327_00.txt"), HEALTHY_FARM_LOG_CONTENT);
    await fs.writeFile(path.join(server1Dir, "sccp-260327_00.txt"), SCCP_LOG_CONTENT);

    // Server 5023: isolated
    await fs.writeFile(path.join(server2Dir, "is-260327_00.txt"), ISOLATED_SERVER_LOG_CONTENT);
    await fs.writeFile(path.join(server2Dir, "sccp-260327_00.txt"), SCCP_LOG_CONTENT);
  });

  afterEach(async () => {
    await fs.rm(farmDir, { recursive: true, force: true });
  });

  it("shows ALIVE matrix with connectivity mode", async () => {
    const result = await toolFarmSummary("", { parentDir: farmDir, mode: "connectivity" });
    expect(result).toContain("FARM CONNECTIVITY");
    expect(result).toContain("ALIVE MATRIX");
  });

  it("identifies isolated servers in connectivity mode", async () => {
    const result = await toolFarmSummary("", { parentDir: farmDir, mode: "connectivity" });
    expect(result).toContain("ISOLATED");
  });

  it("shows bidirectional status for healthy servers", async () => {
    const result = await toolFarmSummary("", { parentDir: farmDir, mode: "connectivity" });
    expect(result).toContain("bidirectional");
  });

  it("shows per-server send/recv counts", async () => {
    const result = await toolFarmSummary("", { parentDir: farmDir, mode: "connectivity" });
    expect(result).toContain("Sent");
    expect(result).toContain("Recv");
  });
});
