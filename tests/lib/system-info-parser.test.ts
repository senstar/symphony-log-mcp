import { describe, it, expect } from "vitest";
import {
  parseServicesTxt,
  parseTasklistTxt,
  parseEventLogTxt,
  parseEnvironmentTxt,
} from "../../src/lib/system-info-parser.js";
import { SERVICES_TXT, TASKLIST_TXT, EVENT_LOG_TXT } from "../fixtures.js";

describe("parseServicesTxt", () => {
  const services = parseServicesTxt(SERVICES_TXT);

  it("returns 3 services", () => {
    expect(services).toHaveLength(3);
  });

  it("parses service names correctly", () => {
    const names = services.map(s => s.serviceName);
    expect(names).toContain("SenstarSymphonyInfoService");
    expect(names).toContain("SenstarSymphonyScheduler");
    expect(names).toContain("Spooler");
  });

  it("parses state and PID", () => {
    const info = services.find(s => s.serviceName === "SenstarSymphonyInfoService")!;
    expect(info.state).toBe("RUNNING");
    expect(info.pid).toBe(1234);

    const sched = services.find(s => s.serviceName === "SenstarSymphonyScheduler")!;
    expect(sched.pid).toBe(5678);

    const spooler = services.find(s => s.serviceName === "Spooler")!;
    expect(spooler.displayName).toBe("Print Spooler");
    expect(spooler.pid).toBe(2222);
  });
});

describe("parseTasklistTxt", () => {
  const processes = parseTasklistTxt(TASKLIST_TXT);

  it("returns 3 processes", () => {
    expect(processes).toHaveLength(3);
  });

  it("parses image names and PIDs", () => {
    const names = processes.map(p => p.imageName);
    expect(names).toContain("infoservice.exe");
    expect(names).toContain("scheduler.exe");
    expect(names).toContain("ae.exe");

    const info = processes.find(p => p.imageName === "infoservice.exe")!;
    expect(info.pid).toBe(1234);
  });

  it("parses memory usage", () => {
    const info = processes.find(p => p.imageName === "infoservice.exe")!;
    expect(info.memUsageKB).toBe(245123);
  });
});

describe("parseEventLogTxt", () => {
  const entries = parseEventLogTxt(EVENT_LOG_TXT);

  it("returns 3 entries", () => {
    expect(entries).toHaveLength(3);
  });

  it("parses levels from EventType codes", () => {
    const levels = entries.map(e => e.level);
    expect(levels).toContain("Error");
    expect(levels).toContain("Information");
    expect(levels).toContain("Warning");
  });

  it("parses sources", () => {
    const sources = entries.map(e => e.source);
    expect(sources).toContain("SenstarInfoService");
    expect(sources).toContain("docker");
    expect(sources).toContain("SenstarScheduler");
  });

  it("parses timestamps", () => {
    for (const entry of entries) {
      expect(entry.timestamp).toMatch(/^\d{4}\/\d{2}\/\d{2}/);
    }
  });
});

describe("parseEnvironmentTxt", () => {
  it("parses key=value pairs", () => {
    const text = "PATH=C:\\Windows\nTEMP=C:\\Temp\nNUMBER_OF_PROCESSORS=8";
    const env = parseEnvironmentTxt(text);
    expect(env["PATH"]).toBe("C:\\Windows");
    expect(env["TEMP"]).toBe("C:\\Temp");
    expect(env["NUMBER_OF_PROCESSORS"]).toBe("8");
  });

  it("handles empty input", () => {
    const env = parseEnvironmentTxt("");
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("handles values containing equals signs", () => {
    const text = "PROMPT=$P$G\nFOO=bar=baz";
    const env = parseEnvironmentTxt(text);
    expect(env["PROMPT"]).toBe("$P$G");
    expect(env["FOO"]).toBe("bar=baz");
  });
});

