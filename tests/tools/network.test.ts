import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolNetwork } from "../../src/tools/network.js";
import { createTestLogDir, type TestLogDir } from "../test-helpers.js";
import { NETWORK_LOG_CONTENT } from "../fixtures.js";
import * as fs from "fs/promises";
import * as path from "path";

let testDir: TestLogDir;
beforeEach(async () => { testDir = await createTestLogDir(); });
afterEach(async () => { await testDir.cleanup(); });

describe("toolNetwork — summary mode", () => {
  it("detects connect, refused, and timeout events", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["hm"], mode: "summary" });
    expect(result).toContain("Network Summary");
    expect(result).toContain("Connections established");
    expect(result).toContain("Connection refused");
    expect(result).toContain("Timeouts");
  });

  it("lists problem targets", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["hm"], mode: "summary" });
    expect(result).toContain("10.60.32.1:8398");
    expect(result).toContain("Problem targets");
  });
});

describe("toolNetwork — events mode", () => {
  it("lists individual events with timestamps", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["hm"], mode: "events" });
    expect(result).toContain("Network Events");
    expect(result).toContain("10:00:01");
    expect(result).toContain("connect");
    expect(result).toContain("refused");
    expect(result).toContain("timeout");
  });
});

describe("toolNetwork — targets mode", () => {
  it("groups events by IP:PORT", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["hm"], mode: "targets" });
    expect(result).toContain("Network events by target");
    expect(result).toContain("10.60.32.1:8398");
  });
});

describe("toolNetwork — timeouts mode", () => {
  it("shows timeout/refused fingerprint groups", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["hm"], mode: "timeouts" });
    expect(result).toContain("Timeout/Refused Patterns");
    expect(result).toContain("10.60.32.1:8398");
  });
});

describe("toolNetwork — IP:PORT regex precision", () => {
  it("extracts valid IP:PORT pairs", async () => {
    const content = [
      '10:00:00.000    1234 <Error   > Communication\tTcp.Send\tConnection timeout: 192.168.1.50:9090',
      '10:00:01.000    1234 <Error   > Communication\tTcp.Send\tConnection refused: 10.0.0.1:443',
    ].join("\n");
    const dir = testDir.dir;
    await fs.writeFile(path.join(dir, "test-260302_00.txt"), content, "utf8");

    const result = await toolNetwork(dir, { files: ["test"], mode: "targets" });
    expect(result).toContain("192.168.1.50:9090");
    expect(result).toContain("10.0.0.1:443");
  });

  it("rejects octets above 255", async () => {
    const content = [
      '10:00:00.000    1234 <Error   > Communication\tTcp.Send\tConnection timeout: 999.999.999.999:80',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "bad-260302_00.txt"), content, "utf8");

    const result = await toolNetwork(testDir.dir, { files: ["bad"], mode: "targets" });
    expect(result).not.toContain("999.999.999.999");
  });

  it("handles IP without port (no port number)", async () => {
    const content = [
      '10:00:00.000    1234 <Error   > Communication\tTcp.Connect\tConnected to 10.60.31.4',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "noport-260302_00.txt"), content, "utf8");

    const result = await toolNetwork(testDir.dir, { files: ["noport"], mode: "targets" });
    expect(result).toContain("10.60.31.4");
  });
});

describe("toolNetwork — empty logs", () => {
  it("returns clean message when no network events", async () => {
    const content = [
      '10:00:00.000       1 <BasicInf> Service\tSomething.Run\tNothing network related here',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "clean-260302_00.txt"), content, "utf8");

    const result = await toolNetwork(testDir.dir, { files: ["clean"] });
    expect(result).toMatch(/no network events/i);
  });

  it("returns message when no files found", async () => {
    const result = await toolNetwork(testDir.dir, { files: ["nonexistent"] });
    expect(result).toMatch(/no log files/i);
  });
});

describe("toolNetwork — DNS failures", () => {
  it("detects DNS resolution failures", async () => {
    const content = [
      '10:00:00.000    1234 <Error   > Communication\tConnectionManager.Connect\tDNS resolution failed for NODE1.corp.local',
      '10:00:01.000    1234 <Error   > Communication\tConnectionManager.Connect\tcould not resolve host NODE2.corp.local',
    ].join("\n");
    await fs.writeFile(path.join(testDir.dir, "dns-260302_00.txt"), content, "utf8");

    const result = await toolNetwork(testDir.dir, { files: ["dns"], mode: "summary" });
    expect(result).toContain("Network Summary");
    expect(result).not.toMatch(/no network events/i);
  });
});

describe("toolNetwork — tryReadLogEntries warnings", () => {
  it("propagates warnings for unreadable files", async () => {
    // Create a directory instead of a file to cause a read error
    await fs.mkdir(path.join(testDir.dir, "broken-260302_00.txt"));

    const result = await toolNetwork(testDir.dir, { files: ["hm", "broken-260302_00.txt"] });
    expect(result).toContain("[WARNING]");
  });
});
