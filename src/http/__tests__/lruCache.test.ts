import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LRUCache } from "../lifecycle/lruCache";

describe("LRUCache", () => {
  describe("basic operations", () => {
    it("stores and retrieves a value", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "value-a", 60_000);
      expect(cache.get("a")).toBe("value-a");
    });

    it("returns undefined for missing keys", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      expect(cache.get("missing")).toBeUndefined();
    });

    it("reports correct size", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      expect(cache.size).toBe(0);
      cache.set("a", "1", 60_000);
      expect(cache.size).toBe(1);
      cache.set("b", "2", 60_000);
      expect(cache.size).toBe(2);
    });

    it("updates value on set with existing key", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "old", 60_000);
      cache.set("a", "new", 60_000);
      expect(cache.get("a")).toBe("new");
      expect(cache.size).toBe(1);
    });

    it("deletes an entry", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "value", 60_000);
      expect(cache.delete("a")).toBe(true);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it("returns false when deleting a non-existent key", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      expect(cache.delete("missing")).toBe(false);
    });

    it("clears all entries", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    });
  });

  describe("TTL expiration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns value within TTL", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "value", 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get("a")).toBe("value");
    });

    it("returns undefined for expired entries", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "value", 1000);
      vi.advanceTimersByTime(1000);
      expect(cache.get("a")).toBeUndefined();
    });

    it("removes expired entry from cache on access", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "value", 1000);
      vi.advanceTimersByTime(1001);
      cache.get("a"); // triggers removal
      expect(cache.size).toBe(0);
    });

    it("updates storedAt on re-set", () => {
      const cache = new LRUCache<string>({ maxEntries: 10 });
      cache.set("a", "v1", 1000);
      vi.advanceTimersByTime(800);
      cache.set("a", "v2", 1000); // resets storedAt
      vi.advanceTimersByTime(800);
      // 800ms since re-set, still within TTL
      expect(cache.get("a")).toBe("v2");
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used entry when at capacity", () => {
      const cache = new LRUCache<string>({ maxEntries: 3 });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000);
      // Cache is full: [c, b, a] (head to tail)
      cache.set("d", "4", 60_000);
      // "a" should be evicted as LRU
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
      expect(cache.get("c")).toBe("3");
      expect(cache.get("d")).toBe("4");
      expect(cache.size).toBe(3);
    });

    it("accessing an entry makes it most recently used", () => {
      const cache = new LRUCache<string>({ maxEntries: 3 });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000);
      // Access "a" to make it MRU: [a, c, b]
      cache.get("a");
      cache.set("d", "4", 60_000);
      // "b" should be evicted as LRU
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe("1");
      expect(cache.get("c")).toBe("3");
      expect(cache.get("d")).toBe("4");
    });

    it("updating an entry makes it most recently used", () => {
      const cache = new LRUCache<string>({ maxEntries: 3 });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000);
      // Update "a" to make it MRU: [a, c, b]
      cache.set("a", "updated", 60_000);
      cache.set("d", "4", 60_000);
      // "b" should be evicted as LRU
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe("updated");
    });

    it("works with maxEntries of 1", () => {
      const cache = new LRUCache<string>({ maxEntries: 1 });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
      expect(cache.size).toBe(1);
    });

    it("enforces minimum maxEntries of 1", () => {
      const cache = new LRUCache<string>({ maxEntries: 0 });
      cache.set("a", "1", 60_000);
      expect(cache.get("a")).toBe("1");
      expect(cache.size).toBe(1);
    });
  });

  describe("eviction callback", () => {
    it("calls onEvict with count when entry is evicted", () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxEntries: 2, onEvict });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      expect(onEvict).not.toHaveBeenCalled();
      cache.set("c", "3", 60_000);
      expect(onEvict).toHaveBeenCalledWith(1);
    });

    it("calls onEvict for each eviction", () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxEntries: 2, onEvict });
      cache.set("a", "1", 60_000);
      cache.set("b", "2", 60_000);
      cache.set("c", "3", 60_000); // evicts "a"
      cache.set("d", "4", 60_000); // evicts "b"
      expect(onEvict).toHaveBeenCalledTimes(2);
    });

    it("does not call onEvict on delete or clear", () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxEntries: 10, onEvict });
      cache.set("a", "1", 60_000);
      cache.delete("a");
      cache.set("b", "2", 60_000);
      cache.clear();
      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  describe("defaults", () => {
    it("defaults maxEntries to 1024", () => {
      const cache = new LRUCache<string>();
      // Fill beyond default — just verify it doesn't throw
      for (let i = 0; i < 1025; i++) {
        cache.set(`key-${i}`, `val-${i}`, 60_000);
      }
      expect(cache.size).toBe(1024);
      // First entry should be evicted
      expect(cache.get("key-0")).toBeUndefined();
      // Last entry should exist
      expect(cache.get("key-1024")).toBe("val-1024");
    });
  });
});
