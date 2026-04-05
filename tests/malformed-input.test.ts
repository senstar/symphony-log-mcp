import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestLogDir, type TestLogDir } from "./test-helpers.js";
import { toolSearchErrors } from "../src/tools/search-errors.js";
import { toolSearchPattern } from "../src/tools/search-pattern.js";
import { toolGetServiceLifecycle } from "../src/tools/service-lifecycle.js";

describe("malformed input handling", () => {
  describe("empty log file (0 bytes)", () => {
    let testDir: TestLogDir;

    beforeEach(async () => {
      testDir = await createTestLogDir({ "is-260302_00.txt": "" });
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors handles empty file without crashing", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
      expect(result).toContain("No errors found");
    });

    it("toolSearchPattern handles empty file without crashing", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["is"],
        pattern: "anything",
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("No matches found");
    });

    it("toolGetServiceLifecycle handles empty file without crashing", async () => {
      const result = await toolGetServiceLifecycle(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
      expect(result).toContain("No lifecycle events found");
    });
  });

  describe("truncated lines (timestamp only, no tab-separated fields)", () => {
    let testDir: TestLogDir;
    const truncatedContent = [
      "10:00:00.000       1 <BasicInf> JustAMessageNoTabs",
      "10:00:01.000       2 <Error   > AnotherLineMissingFields",
      "10:00:02.000",
      "garbage line with no structure",
    ].join("\n");

    beforeEach(async () => {
      testDir = await createTestLogDir({ "is-260302_00.txt": truncatedContent });
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors returns string without throwing", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
    });

    it("toolSearchPattern returns string without throwing", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["is"],
        pattern: "Missing",
      });
      expect(typeof result).toBe("string");
    });

    it("toolGetServiceLifecycle returns string without throwing", async () => {
      const result = await toolGetServiceLifecycle(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
    });
  });

  describe("binary content mixed in", () => {
    let testDir: TestLogDir;
    const binaryContent =
      "10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting\n" +
      "\x00\xFF\xFE\x01binary junk here\n" +
      "10:00:01.000       2 <Error   > Service\tInfoService.OnStop\tService crashed\n";

    beforeEach(async () => {
      testDir = await createTestLogDir({ "is-260302_00.txt": binaryContent });
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors handles binary bytes without crashing", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
    });

    it("toolSearchPattern handles binary bytes without crashing", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["is"],
        pattern: "Service",
      });
      expect(typeof result).toBe("string");
    });

    it("toolSearchErrors still finds the real error", async () => {
      const result = await toolSearchErrors(testDir.dir, {
        files: ["is"],
        deduplicate: false,
      });
      expect(result).toContain("crashed");
    });
  });

  describe("missing expected fields (valid timestamp, wrong structure)", () => {
    let testDir: TestLogDir;
    const weirdContent = [
      "10:00:00.000       1 <BasicInf> \t\t",
      "10:00:01.000       2 <Error   > \t",
      "10:00:02.000       3 <BasicInf> Normal\tSource.Method\tThis is a valid line",
    ].join("\n");

    beforeEach(async () => {
      testDir = await createTestLogDir({ "is-260302_00.txt": weirdContent });
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors returns string without throwing", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
    });

    it("toolSearchPattern returns string without throwing", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["is"],
        pattern: "valid",
      });
      expect(typeof result).toBe("string");
    });
  });

  describe("file with only continuation lines (no primary log lines)", () => {
    let testDir: TestLogDir;
    const continuationOnly = [
      "   at Seer.Web.Handler.Execute() in C:\\src\\Handler.cs:line 42",
      "   at Seer.Web.Pipeline.Run() in C:\\src\\Pipeline.cs:line 18",
      "   at System.Threading.Tasks.Task.Execute()",
    ].join("\n");

    beforeEach(async () => {
      testDir = await createTestLogDir({ "is-260302_00.txt": continuationOnly });
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors returns no errors without crashing", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["is"] });
      expect(typeof result).toBe("string");
      expect(result).toContain("No errors found");
    });

    it("toolSearchPattern returns no matches without crashing", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["is"],
        pattern: "DoesNotExist",
      });
      expect(typeof result).toBe("string");
    });
  });

  describe("nonexistent file reference", () => {
    let testDir: TestLogDir;

    beforeEach(async () => {
      testDir = await createTestLogDir();
    });
    afterEach(async () => { await testDir.cleanup(); });

    it("toolSearchErrors handles missing file prefix gracefully", async () => {
      const result = await toolSearchErrors(testDir.dir, { files: ["zz"] });
      expect(typeof result).toBe("string");
    });

    it("toolSearchPattern handles missing file prefix gracefully", async () => {
      const result = await toolSearchPattern(testDir.dir, {
        files: ["zz"],
        pattern: "test",
      });
      expect(typeof result).toBe("string");
    });

    it("toolGetServiceLifecycle handles missing file prefix gracefully", async () => {
      const result = await toolGetServiceLifecycle(testDir.dir, { files: ["zz"] });
      expect(typeof result).toBe("string");
    });
  });
});
