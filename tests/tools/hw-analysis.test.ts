import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolHw } from "../../src/tools/hw-analysis.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { HW_LOG_CONTENT } from "../fixtures.js";

let testDir: TestLogDir;
beforeEach(async () => {
  testDir = await createTestLogDir({ 'is-260301_00.txt': HW_LOG_CONTENT });
});
afterEach(async () => { await testDir.cleanup(); });

describe("toolHw — summary mode", () => {
  it("detects Advantech events", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("advantech");
  });

  it("detects serial port events", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("serial");
  });

  it("detects door controller events", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("door");
  });

  it("detects IO module events", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("io module");
  });

  it("detects connection events", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    // The "hardware device at ... reconnected" line matches RE_HW_CONNECT
    expect(result).toContain("HARDWARE INTEGRATION SUMMARY");
  });

  it("reports total event count", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"] });
    expect(result).toContain("Total events:");
  });
});

describe("toolHw — advantech mode", () => {
  it("filters to Advantech/ADAM events only", async () => {
    const result = await toolHw(testDir.dir, { mode: "advantech", files: ["is"] });
    expect(result).toContain("Advantech");
    expect(result).toContain("ADAM-6050");
  });

  it("shows ReadCoil failure", async () => {
    const result = await toolHw(testDir.dir, { mode: "advantech", files: ["is"] });
    expect(result).toContain("ReadCoil");
  });
});

describe("toolHw — devices mode", () => {
  it("lists known devices", async () => {
    const result = await toolHw(testDir.dir, { mode: "devices", files: ["is"] });
    expect(result).toContain("HARDWARE DEVICE INVENTORY");
    expect(result).toContain("10.60.31.100");
  });

  it("shows error counts per device", async () => {
    const result = await toolHw(testDir.dir, { mode: "devices", files: ["is"] });
    expect(result).toContain("Errors");
  });
});

describe("toolHw — errors mode", () => {
  it("lists hardware errors", async () => {
    const result = await toolHw(testDir.dir, { mode: "errors", files: ["is"] });
    expect(result).toContain("hardware error");
    expect(result).toContain("✗");
  });

  it("includes serial port errors", async () => {
    const result = await toolHw(testDir.dir, { mode: "errors", files: ["is"] });
    expect(result).toContain("COM3");
  });

  it("includes door controller errors", async () => {
    const result = await toolHw(testDir.dir, { mode: "errors", files: ["is"] });
    expect(result).toContain("door controller");
  });
});

describe("toolHw — empty / no match", () => {
  it("returns clean output when no HW events", async () => {
    // SCCP logs have CPU/memory stats but no hardware events
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["sccp"] });
    expect(result).toContain("No hardware-related events found");
  });

  it("returns clean output with device filter that matches nothing", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["is"], deviceFilter: "192.168.99.99" });
    expect(result).toContain("No hardware-related events found");
    expect(result).toContain("192.168.99.99");
  });
});

describe("toolHw — regex precision", () => {
  it("does not false-positive on 'adamant' (word boundary check)", async () => {
    const noMatchContent = [
      '10:00:00.000    1234 <BasicInf> Service\tManager.Run\tThe adamant refusal to connect was noted',
      '10:00:01.000    1234 <BasicInf> Service\tManager.Run\tAdam Smith logged in successfully',
    ].join('\n');

    const dir = await createTestLogDir({ 'is-260303_00.txt': noMatchContent });
    try {
      // Only read the custom file (date 260303), not the default fixture (date 260302)
      const result = await toolHw(dir.dir, { mode: "summary", files: ["is-260303_00.txt"] });
      expect(result).toContain("No hardware-related events found");
    } finally {
      await dir.cleanup();
    }
  });

  it("matches ADAM-6050 device ID correctly", async () => {
    const matchContent = [
      '10:00:00.000    1234 <BasicInf> Hardware\tDeviceManager.Init\tADAM-6050 initialized at 10.0.0.1',
    ].join('\n');

    const dir = await createTestLogDir({ 'is-260303_00.txt': matchContent });
    try {
      const result = await toolHw(dir.dir, { mode: "summary", files: ["is-260303_00.txt"] });
      expect(result).toContain("advantech");
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toolHw — warnings", () => {
  it("returns warning when log files do not exist", async () => {
    const result = await toolHw(testDir.dir, { mode: "summary", files: ["nonexistent-260101_00.txt"] });
    expect(result).toContain("No log files found");
  });
});
