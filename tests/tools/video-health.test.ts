import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolVideoHealth } from "../../src/tools/video-health.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { VIDEO_LOG_CONTENT } from "../fixtures.js";
import * as fs from "fs/promises";
import * as path from "path";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolVideoHealth — summary mode", () => {
  it("detects camera connect, disconnect, and frame drops", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["cs01"], mode: "summary" });
    expect(result).toContain("Video Health Summary");
    expect(result).toContain("Camera connects");
    expect(result).toContain("Camera disconnects");
    expect(result).toContain("Frame drops");
  });

  it("shows first and last event times", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["cs01"], mode: "summary" });
    expect(result).toContain("First event:");
    expect(result).toContain("Last event:");
  });

  it("shows recent issues section", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["cs01"], mode: "summary" });
    expect(result).toContain("Recent issues");
    expect(result).toContain("disconnect");
    expect(result).toContain("frame drop");
  });
});

describe("toolVideoHealth — events mode", () => {
  it("lists individual events with timestamps and file info", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["cs01"], mode: "events" });
    expect(result).toContain("Video Pipeline Events");
    expect(result).toContain("10:00:00");
    expect(result).toContain("File:");
  });
});

describe("toolVideoHealth — cameras mode", () => {
  it("groups events by source", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["cs01"], mode: "cameras" });
    expect(result).toContain("Video events grouped by source");
    expect(result).toContain("Tracker");
  });
});

describe("toolVideoHealth — reconnect type detection", () => {
  it("classifies disconnect before reconnect (precedence)", async () => {
    const content = [
      '10:00:00.000       1 <Error   > Tracker\tTracker.Net\tCamera 3 disconnected: connection lost',
      '10:00:05.000       1 <BasicInf> Tracker\tTracker.Net\tCamera 3 reconnected successfully',
      '10:00:10.000       1 <BasicInf> Tracker\tTracker.Net\tCamera 3 connected at 15 fps',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "cs02-260302_00.txt"), content, "utf8");

    const result = await toolVideoHealth(testDir.dir, { files: ["cs02"], mode: "events" });
    expect(result).toContain("disconnect");
    expect(result).toContain("reconnect");
    expect(result).toContain("connection");
  });

  it("disconnect regex wins over connect when both could match", async () => {
    // "connection lost" matches disconnect (connection lost) before connect (connection)
    const content = [
      '10:00:00.000       1 <Error   > Tracker\tTracker.Link\tCamera 7 connection lost unexpectedly',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "cs03-260302_00.txt"), content, "utf8");

    const result = await toolVideoHealth(testDir.dir, { files: ["cs03"], mode: "events" });
    expect(result).toContain("disconnect");
    expect(result).not.toMatch(/\bconnection\s{2,}/); // should be disconnect, not connection category
  });
});

describe("toolVideoHealth — empty logs", () => {
  it("returns clean message when no video events", async () => {
    const content = [
      '10:00:00.000       1 <BasicInf> Service\tSomething.Run\tNothing video related here',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "cs99-260302_00.txt"), content, "utf8");

    const result = await toolVideoHealth(testDir.dir, { files: ["cs99"] });
    expect(result).toMatch(/no video pipeline events/i);
  });

  it("returns message when no files found", async () => {
    const result = await toolVideoHealth(testDir.dir, { files: ["nonexistent"] });
    expect(result).toMatch(/no video health log files/i);
  });
});

describe("toolVideoHealth — tryReadLogEntries warnings", () => {
  it("propagates warnings for unreadable files", async () => {
    // Create a directory instead of a file to cause a read error
    await fs.mkdir(path.join(testDir.dir, "cs50-260302_00.txt"));

    const result = await toolVideoHealth(testDir.dir, { files: ["cs50-260302_00.txt"] });
    expect(result).toContain("[WARNING]");
  });
});
