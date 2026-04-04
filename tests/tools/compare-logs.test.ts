import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolCompareLogs } from "../../src/tools/compare-logs.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Helpers ────────────────────────────────────────────────────────────────

async function createMinimalLogDir(
  files: Record<string, string>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-cmp-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const IS_CONTENT_A = [
  '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:00:01.000    1234 <Error   > WebService\tHandler.Execute\tSystem.TimeoutException: timeout',
  '10:00:02.000    1234 <Error   > WebService\tHandler.Execute\tSystem.TimeoutException: timeout',
].join('\n');

const IS_CONTENT_B = [
  '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:00:01.000    1234 <Error   > WebService\tHandler.Execute\tSystem.NullReferenceException: null ref',
].join('\n');

const SCCP_CONTENT = [
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tinfoservice.exe\tPID=1234 CPU=12.3% Mem=245,123K',
].join('\n');

// ── toolCompareLogs ────────────────────────────────────────────────────────

describe("toolCompareLogs", () => {
  it("compares two directories with different errors", async () => {
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    const dirB = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_B,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        labelA: "Build A",
        labelB: "Build B",
        include: ["errors"],
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("Build A");
      expect(result).toContain("Build B");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });

  it("compares identical directories", async () => {
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    const dirB = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        include: ["errors"],
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });

  it("handles empty directory gracefully", async () => {
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
    });
    const dirB = await createMinimalLogDir({});
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        include: ["errors"],
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });

  it("applies time window filtering", async () => {
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    const dirB = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_B,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        include: ["errors"],
        startTimeA: "10:00:00",
        endTimeA: "10:00:01",
        startTimeB: "10:00:00",
        endTimeB: "10:00:01",
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });

  it("includes lifecycle dimension", async () => {
    const lifecycleContent = [
      '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
      '10:00:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
      '10:30:00.000       1 <BasicInf> Service\tInfoService.OnStop\tService stopped',
    ].join('\n');
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": lifecycleContent,
    });
    const dirB = await createMinimalLogDir({
      "is-260302_00.txt": lifecycleContent,
    });
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        include: ["lifecycle"],
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });

  it("includes heuristic summary when summarize=true", async () => {
    const dirA = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_A,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    const dirB = await createMinimalLogDir({
      "is-260302_00.txt": IS_CONTENT_B,
      "sccp-260302_00.txt": SCCP_CONTENT,
    });
    try {
      const result = await toolCompareLogs("", {
        dirA: dirA.dir,
        dirB: dirB.dir,
        include: ["errors"],
        summarize: true,
        detectWindows: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("CHANGE SUMMARY");
    } finally {
      await dirA.cleanup();
      await dirB.cleanup();
    }
  });
});
