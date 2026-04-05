interface TriageCacheEntry {
  result: string;
  mtime: number;
  accessedAt: number;
}

const MAX_ENTRIES = 10;

class TriageCache {
  private cache = new Map<string, TriageCacheEntry>();
  private accessCounter = 0;

  /** Get cached result if key exists and mtime matches */
  get(key: string, mtime: number): string | null {
    const entry = this.cache.get(key);
    if (!entry || entry.mtime !== mtime) return null;
    entry.accessedAt = ++this.accessCounter;
    return entry.result;
  }

  /** Store result with LRU eviction at MAX_ENTRIES */
  set(key: string, mtime: number, result: string): void {
    // If already exists, update
    if (this.cache.has(key)) {
      this.cache.set(key, { result, mtime, accessedAt: ++this.accessCounter });
      return;
    }
    // Evict LRU if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { result, mtime, accessedAt: ++this.accessCounter });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const triageCache = new TriageCache();
