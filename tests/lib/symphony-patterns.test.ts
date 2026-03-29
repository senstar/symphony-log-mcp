import { describe, it, expect } from "vitest";
import { isSymphonyProcess, isSymphonyService, SYMPHONY_PROCESS_PATTERNS, SYMPHONY_SERVICE_PATTERNS } from "../../src/lib/symphony-patterns.js";

describe("isSymphonyProcess", () => {
  const symphonyProcesses = [
    "Tracker(1)",
    "Tracker (5)",
    "infoservice.exe",
    "ae.exe",
    "seermanager.exe",
    "scheduler.exe",
    "fusionengineservice.exe",
    "hardwarecontainerservice.exe",
    "mobilebridge.exe",
    "onvifserver.exe",
    "killall.exe",
    "nssm.exe",
    "surrogateexe.exe",
    "netsendhistmfc.exe",
    "seer.web.host.exe",
  ];

  it.each(symphonyProcesses)("returns true for %s", (name) => {
    expect(isSymphonyProcess(name)).toBe(true);
  });

  const nonSymphonyProcesses = [
    "chrome.exe",
    "explorer.exe",
    "sqlservr.exe",
    "w3wp.exe",
    "System",
    "svchost.exe",
  ];

  it.each(nonSymphonyProcesses)("returns false for %s", (name) => {
    expect(isSymphonyProcess(name)).toBe(false);
  });
});

describe("isSymphonyService", () => {
  it("returns true for Symphony services", () => {
    expect(isSymphonyService("SenstarSymphonyInfoService", "Senstar Symphony Information Service")).toBe(true);
    expect(isSymphonyService("TrackerService", "")).toBe(true);
  });

  it("returns false for non-Symphony services", () => {
    expect(isSymphonyService("Spooler", "Print Spooler")).toBe(false);
    expect(isSymphonyService("W3SVC", "World Wide Web Publishing Service")).toBe(false);
  });
});

describe("pattern arrays are exported", () => {
  it("SYMPHONY_PROCESS_PATTERNS is a non-empty array of RegExp", () => {
    expect(SYMPHONY_PROCESS_PATTERNS.length).toBeGreaterThan(0);
    expect(SYMPHONY_PROCESS_PATTERNS[0]).toBeInstanceOf(RegExp);
  });

  it("SYMPHONY_SERVICE_PATTERNS is a non-empty array of RegExp", () => {
    expect(SYMPHONY_SERVICE_PATTERNS.length).toBeGreaterThan(0);
    expect(SYMPHONY_SERVICE_PATTERNS[0]).toBeInstanceOf(RegExp);
  });
});

