import { describe, it, expect } from "vitest";
import { fingerprint, fingerprintShort } from "../../src/lib/fingerprint.js";

describe("fingerprint", () => {
  it("replaces GUIDs", () => {
    expect(fingerprint("id=d3b07384-d9a0-4e9b-8b0d-a87654321098 done")).toBe("id=<GUID> done");
  });

  it("replaces IP:PORT pairs", () => {
    expect(fingerprint("connect 10.60.31.4:8398")).toBe("connect <IP:PORT>");
  });

  it("replaces bare IP addresses", () => {
    expect(fingerprint("server at 192.168.1.1 responded")).toBe("server at <IP> responded");
  });

  it("replaces hex pointers", () => {
    expect(fingerprint("handle 0x7FFE1234ABCD released")).toBe("handle <PTR> released");
  });

  it("replaces Request(N) IDs", () => {
    expect(fingerprint("Request(39) completed")).toBe("Request(N) completed");
  });

  it("replaces large numbers (5+ digits)", () => {
    expect(fingerprint("PID=12345 size=98765")).toBe("PID=<NUM> size=<NUM>");
  });

  it("replaces array index notation", () => {
    expect(fingerprint("items[42] processed")).toBe("items[N] processed");
  });

  it("collapses whitespace", () => {
    expect(fingerprint("  multiple   spaces  here  ")).toBe("multiple spaces here");
  });

  it("replaces exceptionGuid=", () => {
    expect(fingerprint("exceptionGuid=abc-123-xyz done")).toBe("exceptionGuid=<GUID> done");
  });

  it("handles combined patterns", () => {
    const input =
      "Request(42) from 10.60.31.4:8398 failed id=d3b07384-d9a0-4e9b-8b0d-a87654321098 at 0x0012FF00";
    const result = fingerprint(input);
    expect(result).toContain("Request(N)");
    expect(result).toContain("<IP:PORT>");
    expect(result).toContain("<GUID>");
    expect(result).toContain("<PTR>");
  });
});

describe("fingerprintShort", () => {
  it("truncates to maxLength", () => {
    const long = "A".repeat(200);
    expect(fingerprintShort(long, 120).length).toBeLessThanOrEqual(120);
  });

  it("applies fingerprinting before truncation", () => {
    const input = "id=d3b07384-d9a0-4e9b-8b0d-a87654321098 msg";
    expect(fingerprintShort(input)).toBe("id=<GUID> msg");
  });

  it("uses default maxLength of 120", () => {
    const long = "X".repeat(200);
    expect(fingerprintShort(long).length).toBe(120);
  });
});

