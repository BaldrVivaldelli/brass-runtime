// src/http/lifecycle/lruCache.ts
import { now } from "./timing";

/**
 * Internal node in the doubly-linked list.
 */
type LRUNode<V> = {
  key: string;
  value: V;
  storedAt: number;
  ttlMs: number;
  prev: LRUNode<V> | null;
  next: LRUNode<V> | null;
};

/**
 * Configuration for the LRU cache.
 *
 * @property maxEntries - Maximum number of entries the cache can hold.
 *   Must be >= 1. Values less than 1 are clamped to 1. Fractional values are floored.
 *   Default: 1024.
 * @property onEvict - Optional callback invoked when entries are evicted from the cache.
 *   Receives the number of entries evicted in that operation (currently always 1).
 *
 * @example
 * ```typescript
 * import { LRUCache } from "./lruCache";
 *
 * const cache = new LRUCache<string>({ maxEntries: 100, onEvict: (n) => console.log(`Evicted ${n}`) });
 * ```
 */
export type LRUCacheConfig = {
  /** Maximum number of entries. Must be >= 1. Default: 1024. */
  maxEntries?: number;
  /** Optional callback invoked with the number of entries evicted on each eviction. */
  onEvict?: (count: number) => void;
};

/**
 * Checks whether a cache node has expired based on its storedAt timestamp and TTL.
 */
function isExpired<V>(node: LRUNode<V>): boolean {
  return now() - node.storedAt >= node.ttlMs;
}

/**
 * A generic LRU (Least Recently Used) cache with per-entry TTL support.
 *
 * Uses a doubly-linked list combined with a Map for O(1) get, set, and eviction
 * operations. The head of the list is the most recently used entry; the tail is
 * the least recently used.
 *
 * When the cache exceeds `maxEntries`, the least recently used entry is evicted.
 * Expired entries are lazily removed on access (get).
 *
 * @example
 * ```typescript
 * import { LRUCache } from "./lruCache";
 *
 * const cache = new LRUCache<string>({ maxEntries: 256 });
 * cache.set("user:1", "Alice", 60_000); // TTL of 60 seconds
 * const value = cache.get("user:1");    // "Alice" (moves to head)
 * cache.delete("user:1");               // true
 * ```
 */
export class LRUCache<V> {
  private readonly map = new Map<string, LRUNode<V>>();
  private head: LRUNode<V> | null = null;
  private tail: LRUNode<V> | null = null;
  private readonly maxEntries: number;
  private readonly onEvict: ((count: number) => void) | undefined;

  /**
   * Creates a new LRU cache instance.
   *
   * @param config - Cache configuration options.
   * @param config.maxEntries - Maximum number of entries. Must be >= 1. Default: 1024.
   * @param config.onEvict - Optional eviction callback.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<number>({ maxEntries: 50 });
   * ```
   */
  constructor(config: LRUCacheConfig = {}) {
    const max = config.maxEntries ?? 1024;
    this.maxEntries = Math.max(1, Math.floor(max));
    this.onEvict = config.onEvict;
  }

  /**
   * Returns the number of entries currently in the cache.
   *
   * @returns The current entry count.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<string>();
   * cache.set("a", "1", 10_000);
   * console.log(cache.size); // 1
   * ```
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Retrieves a value by key.
   *
   * Returns `undefined` if the key is not found or the entry has expired.
   * On a hit (non-expired), the entry is moved to the head (most recently used).
   * Expired entries are lazily removed on access.
   *
   * @param key - The cache key to look up.
   * @returns The cached value, or `undefined` if not found or expired.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<string>();
   * cache.set("greeting", "hello", 30_000);
   * const val = cache.get("greeting"); // "hello"
   * const miss = cache.get("unknown"); // undefined
   * ```
   */
  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;

    if (isExpired(node)) {
      this.removeNode(node);
      this.map.delete(key);
      return undefined;
    }

    this.moveToHead(node);
    return node.value;
  }

  /**
   * Inserts or updates an entry in the cache.
   *
   * If the key already exists, the value and TTL are updated and the entry is
   * moved to the head. If inserting a new entry causes the cache to exceed
   * `maxEntries` (must be >= 1), the least recently used entry is evicted.
   *
   * @param key - The cache key.
   * @param value - The value to store.
   * @param ttlMs - Time-to-live in milliseconds. The entry expires after this duration.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<string>({ maxEntries: 2 });
   * cache.set("a", "alpha", 60_000);
   * cache.set("b", "beta", 60_000);
   * cache.set("c", "gamma", 60_000); // evicts "a" (LRU)
   * ```
   */
  set(key: string, value: V, ttlMs: number): void {
    const existing = this.map.get(key);

    if (existing) {
      existing.value = value;
      existing.storedAt = now();
      existing.ttlMs = ttlMs;
      this.moveToHead(existing);
      return;
    }

    const node: LRUNode<V> = {
      key,
      value,
      storedAt: now(),
      ttlMs,
      prev: null,
      next: null,
    };

    this.map.set(key, node);
    this.addToHead(node);

    if (this.map.size > this.maxEntries) {
      this.evictTail();
    }
  }

  /**
   * Removes an entry by key.
   *
   * @param key - The cache key to remove.
   * @returns `true` if the entry was found and removed, `false` otherwise.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<string>();
   * cache.set("x", "value", 10_000);
   * cache.delete("x"); // true
   * cache.delete("x"); // false (already removed)
   * ```
   */
  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Removes all entries from the cache, resetting it to an empty state.
   *
   * @example
   * ```typescript
   * import { LRUCache } from "./lruCache";
   *
   * const cache = new LRUCache<string>();
   * cache.set("a", "1", 10_000);
   * cache.clear();
   * console.log(cache.size); // 0
   * ```
   */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  // --- Doubly-linked list operations ---

  /** Adds a node to the head of the list (most recently used position). */
  private addToHead(node: LRUNode<V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  /** Removes a node from its current position in the list. */
  private removeNode(node: LRUNode<V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }

  /** Moves an existing node to the head of the list. */
  private moveToHead(node: LRUNode<V>): void {
    if (this.head === node) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  /** Evicts the tail node (least recently used) and notifies via callback. */
  private evictTail(): void {
    if (!this.tail) return;

    const evicted = this.tail;
    this.removeNode(evicted);
    this.map.delete(evicted.key);

    if (this.onEvict) {
      this.onEvict(1);
    }
  }
}
