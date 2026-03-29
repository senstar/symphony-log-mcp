import { describe, it, expect } from "vitest";
import { decodePrefix, listKnownPrefixes } from "../../src/lib/prefix-map.js";

describe("decodePrefix", () => {
  describe("exact prefix matches", () => {
    it("decodes 'is' as Information Service", () => {
      const info = decodePrefix("is");
      expect(info.description).toBe("Information Service");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });

    it("decodes 'ae' as AiraExplorer Client", () => {
      const info = decodePrefix("ae");
      expect(info.description).toBe("AiraExplorer Client");
      expect(info.category).toBe("Client");
      expect(info.side).toBe("client");
    });

    it("decodes 'sc' as Scheduler main", () => {
      const info = decodePrefix("sc");
      expect(info.description).toBe("Scheduler (main)");
      expect(info.category).toBe("Scheduler");
      expect(info.side).toBe("server");
    });

    it("decodes 'sccp' as Scheduler CPU/Memory Stats", () => {
      const info = decodePrefix("sccp");
      expect(info.description).toBe("Scheduler – CPU/Memory Stats");
      expect(info.category).toBe("Scheduler");
      expect(info.side).toBe("server");
    });

    it("decodes 'pd' as Process Debugger", () => {
      const info = decodePrefix("pd");
      expect(info.description).toBe("Process Debugger");
      expect(info.category).toBe("Tools");
      expect(info.side).toBe("tool");
    });

    it("decodes 'mo' as Mobile Bridge", () => {
      const info = decodePrefix("mo");
      expect(info.description).toBe("Mobile Bridge");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });

    it("decodes 'hm' as Health Monitoring / Watchdog", () => {
      const info = decodePrefix("hm");
      expect(info.description).toBe("Health Monitoring / Watchdog");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });

    it("decodes 'da' as Data Access Service", () => {
      const info = decodePrefix("da");
      expect(info.description).toBe("Data Access Service");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });

    it("decodes 'http' as Web Host", () => {
      const info = decodePrefix("http");
      expect(info.description).toBe("Web Host (Seer.Web.Host)");
      expect(info.category).toBe("Web");
      expect(info.side).toBe("server");
    });

    it("decodes 'ac' as Access Control", () => {
      const info = decodePrefix("ac");
      expect(info.description).toBe("Access Control");
      expect(info.category).toBe("Access Control");
      expect(info.side).toBe("server");
    });

    it("decodes 'sso' as SSO Server", () => {
      const info = decodePrefix("sso");
      expect(info.description).toBe("SSO Server");
      expect(info.category).toBe("SSO");
      expect(info.side).toBe("server");
    });

    it("decodes 'vp' as VMS Player", () => {
      const info = decodePrefix("vp");
      expect(info.description).toContain("VMS Player");
      expect(info.category).toBe("Video");
      expect(info.side).toBe("client");
    });

    it("decodes 'fe' as Fusion Engine Service", () => {
      const info = decodePrefix("fe");
      expect(info.description).toBe("Fusion Engine Service");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });
  });

  describe("dynamic prefix patterns", () => {
    it("decodes 'cs01' as Tracker for camera 1", () => {
      const info = decodePrefix("cs01");
      expect(info.description).toContain("Tracker for camera 1");
      expect(info.category).toBe("Tracker");
      expect(info.side).toBe("server");
    });

    it("decodes 'cs3' as Tracker for camera 3", () => {
      const info = decodePrefix("cs3");
      expect(info.description).toContain("Tracker for camera 3");
      expect(info.category).toBe("Tracker");
      expect(info.side).toBe("server");
    });

    it("decodes 'cs123' as Tracker for camera 123", () => {
      const info = decodePrefix("cs123");
      expect(info.description).toContain("Tracker for camera 123");
    });

    it("decodes 'se00A' as Surrogate/OPX viewing panel", () => {
      const info = decodePrefix("se00A");
      expect(info.description).toContain("Surrogate/OPX viewing panel");
      expect(info.description).toContain("ID=00a");
      expect(info.category).toBe("Video");
      expect(info.side).toBe("client");
    });

    it("decodes 'hcs1' as Hardware Container Service instance", () => {
      const info = decodePrefix("hcs1");
      expect(info.description).toContain("Hardware Container Service instance 1");
      expect(info.category).toBe("Server");
      expect(info.side).toBe("server");
    });

    it("decodes 'hs01' as NetSendHistChild instance", () => {
      const info = decodePrefix("hs01");
      expect(info.description).toContain("NetSendHistChild instance 01");
      expect(info.category).toBe("Video History");
      expect(info.side).toBe("server");
    });

    it("decodes 'ae_8000' as AiraExplorer with port", () => {
      const info = decodePrefix("ae_8000");
      expect(info.description).toContain("AiraExplorer Client");
      expect(info.description).toContain("8000");
      expect(info.category).toBe("Client");
      expect(info.side).toBe("client");
    });
  });

  describe("edge cases", () => {
    it("decodes bare 'se' as Setup Wizard / Surrogate ambiguity", () => {
      const info = decodePrefix("se");
      expect(info.description).toContain("Setup Wizard");
      expect(info.description).toContain("Surrogate/OPX");
      expect(info.category).toBe("Setup");
      expect(info.side).toBe("tool");
    });

    it("strips trailing dash — 'se-' resolves same as 'se'", () => {
      const info = decodePrefix("se-");
      expect(info.description).toContain("Setup Wizard");
      expect(info.category).toBe("Setup");
    });

    it("is case-insensitive", () => {
      const info = decodePrefix("IS");
      expect(info.description).toBe("Information Service");
    });

    it("returns Unknown for unrecognized prefix", () => {
      const info = decodePrefix("zzz");
      expect(info.description).toBe("Unknown prefix");
      expect(info.category).toBe("Unknown");
      expect(info.side).toBe("server");
    });
  });
});

describe("listKnownPrefixes", () => {
  it("returns a non-empty array", () => {
    const prefixes = listKnownPrefixes();
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it("includes the 'is' prefix", () => {
    const prefixes = listKnownPrefixes();
    const is = prefixes.find((p) => p.prefix === "is");
    expect(is).toBeDefined();
    expect(is!.description).toBe("Information Service");
  });

  it("every entry has description, category, and side", () => {
    const prefixes = listKnownPrefixes();
    for (const entry of prefixes) {
      expect(entry.prefix).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(["server", "client", "tool", "integration", "test"]).toContain(entry.side);
    }
  });
});

