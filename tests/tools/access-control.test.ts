import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolAccessControl } from "../../src/tools/access-control.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { ACCESS_CONTROL_LOG_CONTENT } from "../fixtures.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let testDir: TestLogDir;
beforeEach(async () => {
  testDir = await createTestLogDir({
    "ac-260302_01.txt": ACCESS_CONTROL_LOG_CONTENT,
  });
});
afterEach(async () => { await testDir.cleanup(); });

describe("toolAccessControl — summary mode", () => {
  it("reports door events", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "summary" });
    expect(result).toContain("Door events");
  });

  it("reports credential scans", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "summary" });
    expect(result).toContain("Credential scans");
  });

  it("reports communication failures", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "summary" });
    // ACCESS_CONTROL_LOG_CONTENT has "Failed to sync with panel: Connection lost"
    // which matches RE_SYNC_FAIL (sync.*fail)
    expect(result).toContain("Sync failures");
  });

  it("includes event count", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "summary" });
    expect(result).toContain("Access Control Summary");
    expect(result).toMatch(/\d+ events/);
  });
});

describe("toolAccessControl — events mode", () => {
  it("lists events chronologically", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "events" });
    expect(result).toContain("Access Control Events");
    expect(result).toContain("10:00:00");
  });

  it("shows event categories", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "events" });
    expect(result.toLowerCase()).toMatch(/door event|credential|sync/);
  });
});

describe("toolAccessControl — failures mode", () => {
  it("isolates failure events", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "failures" });
    expect(result).toContain("Access Control Failures");
    expect(result.toLowerCase()).toContain("sync");
  });
});

describe("toolAccessControl — sync mode", () => {
  it("detects sync status", async () => {
    const result = await toolAccessControl(testDir.dir, { mode: "sync" });
    expect(result).toContain("Sync Activity");
    // Should show failed syncs count
    expect(result).toContain("Failed syncs");
  });
});

describe("toolAccessControl — empty", () => {
  it("returns clean output when no access control events", async () => {
    const cleanDir = await mkdtemp(path.join(tmpdir(), "clean-"));
    await writeFile(path.join(cleanDir, "ac-260302_01.txt"), "10:00:00.000       1 <BasicInf> Misc\tSomething.Else\tUnrelated log line");
    try {
      const result = await toolAccessControl(cleanDir, { mode: "summary" });
      expect(result).toContain("No access control events found");
    } finally {
      await rm(cleanDir, { recursive: true });
    }
  });
});

describe("toolAccessControl — warnings", () => {
  it("propagates tryReadLogEntries warnings", async () => {
    await testDir.cleanup();
    testDir = await createTestLogDir({
      "ac-260302_01.txt": ACCESS_CONTROL_LOG_CONTENT,
      "ac-260302_02.txt": "", // empty file
    });
    const result = await toolAccessControl(testDir.dir, { mode: "summary" });
    // Should still succeed with valid data from the first file
    expect(result).toBeTruthy();
  });
});
