import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolTraceMbRequest } from "../../src/tools/trace-mb-request.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Fixture log content ────────────────────────────────────────────────────

const MO_LOG_HAPPY = [
  "10:00:01.100 40 <BasicInf> MobileBridge\tMessageDispatcher.SendRequest[1]\tSent Request(GetDeviceGraphCompressed)[f95644eb-1234-5678-abcd-000000000001] with sequence #17",
  "10:00:01.150 40 <BasicInf> MobileBridge\tMessageDispatcher.HandleResponse[1]\tReceived response to Request(GetDeviceGraphCompressed)[f95644eb-1234-5678-abcd-000000000001] with sequence #17",
  "10:00:05.200 40 <BasicInf> MobileBridge\tMessageDispatcher.SendRequest[1]\tSent Request(GetDeviceGraphCompressed)[f95644eb-1234-5678-abcd-000000000002] with sequence #18",
  "10:00:05.260 40 <BasicInf> MobileBridge\tMessageDispatcher.HandleResponse[1]\tReceived response to Request(GetDeviceGraphCompressed)[f95644eb-1234-5678-abcd-000000000002] with sequence #18",
].join("\n");

const IS_LOG_HAPPY = [
  "10:00:01.110 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvoking request Request(17)[GetDeviceGraphCompressed] receieved from 127.0.0.1:6172 with session ID a1b2c3d4-0000-0000-0000-000000000001",
  "10:00:01.112 12 <BasicInf> WebService\tSignals.GetDeviceGraphCompressed[127.0.0.1:6172]\tInvoked by ___$System$___: GetDeviceGraphCompressed",
  "10:00:01.140 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvocation of request Request(17)[GetDeviceGraphCompressed] for 127.0.0.1:6172 took 00:00:00.0300000",
  "10:00:05.210 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvoking request Request(18)[GetDeviceGraphCompressed] receieved from 127.0.0.1:6172 with session ID a1b2c3d4-0000-0000-0000-000000000002",
  "10:00:05.212 12 <BasicInf> WebService\tSignals.GetDeviceGraphCompressed[127.0.0.1:6172]\tInvoked by operator: GetDeviceGraphCompressed",
  "10:00:05.250 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvocation of request Request(18)[GetDeviceGraphCompressed] for 127.0.0.1:6172 took 00:00:00.0400000",
].join("\n");

const MO_LOG_SENT_ONLY = [
  "10:00:01.100 40 <BasicInf> MobileBridge\tMessageDispatcher.SendRequest[1]\tSent Request(GetSystemStatus)[aaaa1111-0000-0000-0000-000000000001] with sequence #5",
].join("\n");

const IS_LOG_INVOKE_ONLY = [
  "10:00:01.110 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvoking request Request(5)[GetSystemStatus] receieved from 127.0.0.1:6172 with session ID b2c3d4e5-0000-0000-0000-000000000001",
].join("\n");

const MO_LOG_MULTI = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const sec = String(i).padStart(2, "0");
    const guid = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    lines.push(
      `10:00:${sec}.100 40 <BasicInf> MobileBridge\tMessageDispatcher.SendRequest[1]\tSent Request(Ping)[${guid}] with sequence #${100 + i}`,
      `10:00:${sec}.150 40 <BasicInf> MobileBridge\tMessageDispatcher.HandleResponse[1]\tReceived response to Request(Ping)[${guid}] with sequence #${100 + i}`,
    );
  }
  return lines.join("\n");
})();

const IS_LOG_MULTI = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const sec = String(i).padStart(2, "0");
    lines.push(
      `10:00:${sec}.110 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvoking request Request(${100 + i})[Ping] receieved from 127.0.0.1:6172 with session ID 00000000-0000-0000-0000-000000000000`,
      `10:00:${sec}.140 12 <BasicInf> WebService\tWebServiceRequestProcessor.ProcessRequest[1]\tInvocation of request Request(${100 + i})[Ping] for 127.0.0.1:6172 took 00:00:00.0300000`,
    );
  }
  return lines.join("\n");
})();

// ── Tests ──────────────────────────────────────────────────────────────────

describe("toolTraceMbRequest", () => {
  let testDir: TestLogDir;

  afterEach(async () => {
    if (testDir) await testDir.cleanup();
  });

  it("traces a happy-path request through Mo and IS logs", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_HAPPY,
      "is-260302_00.txt": IS_LOG_HAPPY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "GetDeviceGraphCompressed",
    });

    expect(result).toContain('Request trace: "GetDeviceGraphCompressed"');
    expect(result).toContain("seq #17");
    expect(result).toContain("seq #18");
    expect(result).toContain("Mo → IS");
    expect(result).toContain("IS recv");
    expect(result).toContain("IS done");
    expect(result).toContain("Mo recv");
    expect(result).toContain("round_trip=");
    expect(result).toContain("duration=");
    // Check invoker from handler line
    expect(result).toContain("___$System$___");
  });

  it("returns not-found message when request name has no matches", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_HAPPY,
      "is-260302_00.txt": IS_LOG_HAPPY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "NonExistentRequest",
    });

    expect(result).toContain("No MobileBridge");
    expect(result).toContain("NonExistentRequest");
  });

  it("returns no-files message when no Mo or IS files exist", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-no-mo-is-"));
    try {
      const result = await toolTraceMbRequest(emptyDir, {
        requestName: "GetDeviceGraphCompressed",
      });

      expect(result).toContain("No Mo or IS log files found");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("handles Mo sent without matching recv", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_SENT_ONLY,
      "is-260302_00.txt": IS_LOG_INVOKE_ONLY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "GetSystemStatus",
    });

    expect(result).toContain("Mo → IS");
    expect(result).toContain("response not yet seen");
  });

  it("handles IS invoke without completion", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_SENT_ONLY,
      "is-260302_00.txt": IS_LOG_INVOKE_ONLY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "GetSystemStatus",
    });

    expect(result).toContain("IS recv");
    // Should NOT contain "IS done" since there's no completion line
    expect(result).not.toContain("IS done");
  });

  it("respects limit parameter", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_MULTI,
      "is-260302_00.txt": IS_LOG_MULTI,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "Ping",
      limit: 2,
    });

    expect(result).toContain("Showing 2 of");
    // Count instance headers
    const instanceCount = (result.match(/─── Instance @/g) || []).length;
    expect(instanceCount).toBe(2);
  });

  it("shows round-trip stats when multiple samples exist", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_HAPPY,
      "is-260302_00.txt": IS_LOG_HAPPY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "GetDeviceGraphCompressed",
    });

    expect(result).toContain("Round-trip stats");
    expect(result).toMatch(/min=\d+ms/);
    expect(result).toMatch(/avg=\d+ms/);
    expect(result).toMatch(/max=\d+ms/);
  });

  it("shows session ID when non-zero", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_HAPPY,
      "is-260302_00.txt": IS_LOG_HAPPY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "GetDeviceGraphCompressed",
    });

    // First invoke has a non-zero session ID
    expect(result).toContain("session=a1b2c3d4");
  });

  it("case-insensitive request name matching", async () => {
    testDir = await createTestLogDir({
      "Mo-260302_00.txt": MO_LOG_HAPPY,
      "is-260302_00.txt": IS_LOG_HAPPY,
    });

    const result = await toolTraceMbRequest(testDir.dir, {
      requestName: "getdevicegraphcompressed",
    });

    expect(result).toContain("seq #17");
    expect(result).toContain("Mo → IS");
  });
});
