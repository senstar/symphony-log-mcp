/**
 * Tests for pd-crashes tool (sym_pd).
 * Tests PDebug minidump crash log parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { toolGetPdCrashes } from "../../src/tools/pd-crashes.js";

// ── Mock PDebug log content ─────────────────────────────────────────────────

const PD_SINGLE_CRASH = [
  '14:22:33.100    8888 <Error   > *** new crash',
  '14:22:33.101    8888 <All     > Saved minidump to C:\\ProgramData\\Senstar\\Dumps\\trackerapp_20260308_142233.dmp.  Error code=S_OK',
  '14:22:33.102    8888 <All     > Terminating process C:\\Program Files\\Senstar\\Symphony\\trackerapp.exe (PID 8588)',
  '14:22:33.103    8888 <All     > Command line: "C:\\Program Files\\Senstar\\Symphony\\trackerapp.exe" -camera 5',
  '14:22:33.200    8888 <All     > Stack for thread 8588',
  '14:22:33.201    8888 <All     > RAX: 0000000000000000  RBX: 0000007FFE000001  RCX: FFFFFFFFFFFFFFFF',
  '14:22:33.202    8888 <All     > 7FFFB2D6A8C1(0, 0, 0, 0)+0000: C:\\Windows\\SYSTEM32\\ntdll.dll(10.0.19041.1) at NtWaitForSingleObject()+0014',
  '14:22:33.203    8888 <All     > 7FFFB2D5B120(0, 0, 0, 0)+0000: C:\\Windows\\SYSTEM32\\KERNELBASE.dll(10.0.19041.1) at WaitForSingleObjectEx()+0089',
  '14:22:33.204    8888 <All     > 7FFFA1234567(0, 0, 0, 0)+0000: C:\\Program Files\\Senstar\\Symphony\\trackerapp.exe(7.3.2.1) at CameraThread::Run()+0042',
  '14:22:33.300    8888 <All     > Stack for thread 9012',
  '14:22:33.301    8888 <All     > RAX: 0000000000000001  RBX: 0000000000000002',
  '14:22:33.302    8888 <All     > 7FFFB2D6A8C1(0, 0, 0, 0)+0000: C:\\Windows\\SYSTEM32\\ntdll.dll(10.0.19041.1) at RtlUserThreadStart()+0021',
].join('\n');

const PD_MULTIPLE_CRASHES = [
  '14:00:00.000    1111 <Error   > *** new crash',
  '14:00:00.001    1111 <All     > Saved minidump to C:\\Dumps\\infoservice_crash1.dmp.  Error code=S_OK',
  '14:00:00.002    1111 <All     > Terminating process C:\\Senstar\\infoservice.exe (PID 1234)',
  '14:00:00.100    1111 <All     > Stack for thread 1234',
  '14:00:00.101    1111 <All     > 7FFF00001000(0, 0, 0, 0)+0000: C:\\Senstar\\infoservice.exe(7.3.2.1) at DbManager::Execute()+0033',
  '',
  '15:00:00.000    2222 <Error   > *** new crash',
  '15:00:00.001    2222 <All     > Saved minidump to C:\\Dumps\\scheduler_crash.dmp.  Error code=S_OK',
  '15:00:00.002    2222 <All     > Terminating process C:\\Senstar\\scheduler.exe (PID 5678)',
  '15:00:00.100    2222 <All     > Stack for thread 5678',
  '15:00:00.101    2222 <All     > 7FFF00002000(0, 0, 0, 0)+0000: C:\\Senstar\\scheduler.exe(7.3.2.1) at TaskRunner::Process()+0055',
  '',
  '16:00:00.000    3333 <Error   > *** new crash',
  '16:00:00.001    3333 <All     > Saved minidump to C:\\Dumps\\trackerapp_crash.dmp.  Error code=S_OK',
  '16:00:00.002    3333 <All     > Terminating process C:\\Senstar\\trackerapp.exe (PID 9999)',
  '16:00:00.100    3333 <All     > Stack for thread 9999',
  '16:00:00.101    3333 <All     > 7FFF00003000(0, 0, 0, 0)+0000: C:\\Senstar\\trackerapp.exe(7.3.2.1) at CameraStream::Decode()+0012',
].join('\n');

const PD_NO_STACK = [
  '14:00:00.000    1111 <Error   > *** new crash',
  '14:00:00.001    1111 <All     > Saved minidump to C:\\Dumps\\crash.dmp.  Error code=S_OK',
  '14:00:00.002    1111 <All     > Terminating process C:\\Senstar\\ae.exe (PID 4444)',
].join('\n');

// ── Helpers ─────────────────────────────────────────────────────────────────

interface TestDir {
  dir: string;
  cleanup: () => Promise<void>;
}

async function createPdTestDir(files: Record<string, string>): Promise<TestDir> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-pd-test-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return {
    dir,
    cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("toolGetPdCrashes", () => {
  let testDir: TestDir;

  afterEach(async () => { if (testDir) await testDir.cleanup(); });

  it("parses single crash with register dump and stack frames", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_SINGLE_CRASH });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("1 crash");
    expect(result).toContain("trackerapp.exe");
    expect(result).toContain("PID(8588)");
    expect(result).toContain("14:22:33.100");
  });

  it("extracts DLL and symbol names from stack frames", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_SINGLE_CRASH });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("ntdll.dll");
    expect(result).toContain("KERNELBASE.dll");
    expect(result).toContain("CameraThread::Run");
  });

  it("extracts minidump path", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_SINGLE_CRASH });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("trackerapp_20260308_142233.dmp");
  });

  it("handles multiple crash blocks", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_MULTIPLE_CRASHES });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("3 crash");
    expect(result).toContain("infoservice.exe");
    expect(result).toContain("scheduler.exe");
    expect(result).toContain("trackerapp.exe");
  });

  it("shows crash summary by process", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_MULTIPLE_CRASHES });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("Crash Summary by Process");
  });

  it("parses crash with no stack trace", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_NO_STACK });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("1 crash");
    expect(result).toContain("ae.exe");
    expect(result).toContain("Threads: 0");
  });

  it("handles multiple threads per crash", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_SINGLE_CRASH });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toContain("Thread 8588");
    expect(result).toContain("Thread 9012");
    expect(result).toContain("Threads: 2");
  });

  it("returns no-data for missing pd files", async () => {
    testDir = await createPdTestDir({ "is-260302_00.txt": "some content" });
    const result = await toolGetPdCrashes(testDir.dir, { files: ["pd"] });

    expect(result).toMatch(/no pd log|no crash/i);
  });

  it("respects framesPerThread limit", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_SINGLE_CRASH });
    const result = await toolGetPdCrashes(testDir.dir, {
      files: ["pd"],
      framesPerThread: 1,
    });

    // Should show only 1 frame and indicate more
    expect(result).toMatch(/more frames/i);
  });

  it("respects limit parameter for crash count", async () => {
    testDir = await createPdTestDir({ "pd-260302_00.txt": PD_MULTIPLE_CRASHES });
    const result = await toolGetPdCrashes(testDir.dir, {
      files: ["pd"],
      limit: 1,
    });

    expect(result).toContain("showing 1");
  });
});
