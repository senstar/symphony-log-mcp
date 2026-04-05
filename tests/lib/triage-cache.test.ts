import { describe, it, expect, beforeEach } from "vitest";
import { triageCache } from "../../src/lib/triage-cache.js";

describe("triageCache", () => {
  beforeEach(() => {
    triageCache.clear();
  });

  it("returns null for cache miss", () => {
    expect(triageCache.get("/some/path", 1000)).toBeNull();
  });

  it("returns cached result on hit", () => {
    triageCache.set("/logs", 1000, "triage report");
    expect(triageCache.get("/logs", 1000)).toBe("triage report");
  });

  it("returns null when mtime differs", () => {
    triageCache.set("/logs", 1000, "report");
    expect(triageCache.get("/logs", 2000)).toBeNull();
  });

  it("clear() empties all entries", () => {
    triageCache.set("/a", 1, "r1");
    triageCache.set("/b", 2, "r2");
    expect(triageCache.size).toBe(2);
    triageCache.clear();
    expect(triageCache.size).toBe(0);
    expect(triageCache.get("/a", 1)).toBeNull();
  });

  it("updates existing entry on same key", () => {
    triageCache.set("/logs", 1000, "old");
    triageCache.set("/logs", 2000, "new");
    expect(triageCache.size).toBe(1);
    expect(triageCache.get("/logs", 2000)).toBe("new");
  });

  it("evicts LRU entry when exceeding 10 entries", () => {
    // Fill cache with 10 entries
    for (let i = 0; i < 10; i++) {
      triageCache.set(`/dir${i}`, i, `result${i}`);
    }
    expect(triageCache.size).toBe(10);

    // Access dir0 to make it recently used
    triageCache.get("/dir0", 0);

    // Add 11th entry — should evict dir1 (least recently used, since dir0 was just accessed)
    triageCache.set("/dir10", 10, "result10");
    expect(triageCache.size).toBe(10);

    // dir1 should be evicted (it was accessed earliest and not re-accessed)
    expect(triageCache.get("/dir1", 1)).toBeNull();

    // dir0 should survive (was re-accessed)
    expect(triageCache.get("/dir0", 0)).toBe("result0");

    // dir10 should exist
    expect(triageCache.get("/dir10", 10)).toBe("result10");
  });

  it("size reflects current entry count", () => {
    expect(triageCache.size).toBe(0);
    triageCache.set("/a", 1, "r");
    expect(triageCache.size).toBe(1);
    triageCache.set("/b", 2, "r");
    expect(triageCache.size).toBe(2);
  });
});
