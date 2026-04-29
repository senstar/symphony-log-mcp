import { describe, it, expect } from "vitest";
import { parseSccpLine } from "../src/tools/process-lifetimes.js";

describe("parseSccpLine ? VA space extraction", () => {
  it("extracts Free and MaxFree VA columns from CpuCounter.cpp format", () => {
    const line = "          infoservice.exe PID(   1234):   242   6396     1     3        546       112  1750.96  1556.46   12% 04/17 19:40  0023:23:00  0002:45:36";
    const result = parseSccpLine(line);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("infoservice.exe");
    expect(result!.pid).toBe(1234);
    expect(result!.freeVA).toBe(546);
    expect(result!.maxFreeVA).toBe(112);
    expect(result!.mem).toBeCloseTo(1750.96, 1);
    expect(result!.cpu).toBe(12);
    expect(result!.processStart).toBe("04/17 19:40");
  });

  it("extracts low VA values for pressure detection", () => {
    const line = "              Tracker(   1) PID(   9012):   120   2100     3     5         80        40   530.00   490.00   28% 04/17 19:42  0005:05:00  0000:46:00";
    const result = parseSccpLine(line);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Tracker(   1)");
    expect(result!.freeVA).toBe(80);
    expect(result!.maxFreeVA).toBe(40);
  });

  it("handles large VA values (healthy process)", () => {
    const line = "            scheduler.exe PID(   5678):    85    890     0     2       1200       800   112.45   100.22    5% 04/17 19:40  0010:15:00  0001:30:00";
    const result = parseSccpLine(line);
    expect(result).not.toBeNull();
    expect(result!.freeVA).toBe(1200);
    expect(result!.maxFreeVA).toBe(800);
  });

  it("returns null for non-matching lines", () => {
    expect(parseSccpLine("not a sccp line")).toBeNull();
    expect(parseSccpLine("")).toBeNull();
    expect(parseSccpLine("  Header line with no PID")).toBeNull();
  });
});
