import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseLogFilename,
  isInTimeWindow,
  formatBytes,
  listLogFiles,
  readRawLines,
  readRawLinesWithTimeFilter,
  resolveFileRefs,
} from "../../src/lib/log-reader.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";

describe("parseLogFilename", () => {
  it("parses is-260302_00.txt", () => {
    const result = parseLogFilename("is-260302_00.txt");
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe("is");
    expect(result!.date).toBe("260302");
    expect(result!.rollover).toBe("00");
  });

  it("parses cs01-260302_31.txt", () => {
    const result = parseLogFilename("cs01-260302_31.txt");
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe("cs01");
  });

  it("returns null for invalid filenames", () => {
    expect(parseLogFilename("readme.txt")).toBeNull();
    expect(parseLogFilename("notes.md")).toBeNull();
  });
});

describe("isInTimeWindow", () => {
  it("returns true when no bounds specified", () => {
    expect(isInTimeWindow("10:30:00")).toBe(true);
  });

  it("returns true when within bounds", () => {
    expect(isInTimeWindow("10:30:00", "10:00:00", "11:00:00")).toBe(true);
  });

  it("returns false when before start", () => {
    expect(isInTimeWindow("09:00:00", "10:00:00", "11:00:00")).toBe(false);
  });

  it("returns false when after end", () => {
    expect(isInTimeWindow("12:00:00", "10:00:00", "11:00:00")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("listLogFiles", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns files from test directory", async () => {
    const files = await listLogFiles(testDir.dir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("filters by prefix", async () => {
    const files = await listLogFiles(testDir.dir, { prefix: "is" });
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.prefix).toBe("is");
    }
  });
});

describe("readRawLines", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("reads a test file and returns array of lines", async () => {
    const files = await listLogFiles(testDir.dir, { prefix: "is" });
    const lines = await readRawLines(files[0].fullPath);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("readRawLinesWithTimeFilter", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("returns subset of lines in time window", async () => {
    const files = await listLogFiles(testDir.dir, { prefix: "is" });
    const allLines = await readRawLines(files[0].fullPath);
    const filtered = await readRawLinesWithTimeFilter(files[0].fullPath, "10:00:05", "10:00:07");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(allLines.length);
  });
});

describe("isInTimeWindow — midnight-spanning", () => {
  it("normal window: entry inside is IN", () => {
    expect(isInTimeWindow("12:00:00", "10:00", "14:00")).toBe(true);
  });

  it("normal window: entry outside is OUT", () => {
    expect(isInTimeWindow("08:00:00", "10:00", "14:00")).toBe(false);
  });

  it("midnight-spanning: entry at 23:30 is IN", () => {
    expect(isInTimeWindow("23:30:00", "23:00", "02:00")).toBe(true);
  });

  it("midnight-spanning: entry at 00:30 is IN", () => {
    expect(isInTimeWindow("00:30:00", "23:00", "02:00")).toBe(true);
  });

  it("midnight-spanning: entry at 10:00 is OUT", () => {
    expect(isInTimeWindow("10:00:00", "23:00", "02:00")).toBe(false);
  });

  it("full day: no start/end matches everything", () => {
    expect(isInTimeWindow("00:00:00")).toBe(true);
    expect(isInTimeWindow("12:00:00")).toBe(true);
    expect(isInTimeWindow("23:59:59")).toBe(true);
  });

  it("edge: entry exactly at startTime is IN", () => {
    expect(isInTimeWindow("10:00:00", "10:00", "14:00")).toBe(true);
  });

  it("edge: entry exactly at endTime is OUT (endTime exclusive with short format)", () => {
    expect(isInTimeWindow("14:00:00", "10:00", "14:00")).toBe(false);
  });

  it("edge: midnight-spanning entry exactly at startTime is IN", () => {
    expect(isInTimeWindow("23:00:00", "23:00", "02:00")).toBe(true);
  });

  it("edge: midnight-spanning entry exactly at endTime is OUT (endTime exclusive with short format)", () => {
    expect(isInTimeWindow("02:00:00", "23:00", "02:00")).toBe(false);
  });
});

describe("resolveFileRefs", () => {
  let testDir: TestLogDir;
  beforeEach(async () => { testDir = await createTestLogDir(); });
  afterEach(async () => { await testDir.cleanup(); });

  it("resolves prefix to matching files", async () => {
    const paths = await resolveFileRefs(["is"], testDir.dir);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toContain("is-260302");
    }
  });

  it("resolves exact filename", async () => {
    const paths = await resolveFileRefs(["is-260302_00.txt"], testDir.dir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("is-260302_00.txt");
  });
});

