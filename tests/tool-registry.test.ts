import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tool-registry.js";

describe("tool-registry", () => {
  it("exports a non-empty TOOLS array", () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  it("every tool has a sym_ prefix", () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^sym_/);
    }
  });
});

