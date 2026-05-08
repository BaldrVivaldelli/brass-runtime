// src/http/lifecycle/index.ts — Barrel export for the HTTP Lifecycle Client module.

// Public types
export type {
  LifecycleClientConfig,
  LifecycleClient,
  LifecycleStats,
  LifecycleEvent,
  LifecycleEventType,
  LifecycleRequestOptions,
  DedupConfig,
  CacheConfig,
  CachePolicyResult,
  PriorityConfig,
} from "./types";

// Lifecycle client factories
export { makeLifecycleClient, makeHttpClient } from "./lifecycleClient";

// Cache key utilities
export {
  computeCacheKey,
  parseCacheKey,
  SEPARATOR,
  DEFAULT_CACHE_RELEVANT_HEADERS,
} from "./cacheKey";
export type { CacheKeyComponents } from "./cacheKey";

// Middleware factories
export { withAuth, withLogging, withResponseTransform } from "./middleware";
export type { LogEvent } from "./middleware";

// LRU cache (standalone utility)
export { LRUCache } from "./lruCache";
export type { LRUCacheConfig } from "./lruCache";

// Priority queue (standalone utility)
export { PriorityQueue, clampPriority } from "./priorityQueue";
export type { PriorityQueueEntry } from "./priorityQueue";

// Stats tracker
export { LifecycleStatsTracker } from "./stats";

// Advanced middleware (usable standalone for power users)
export { withDedup } from "./dedup";
export { withCache } from "./responseCache";
export { withPriority } from "./priorityScheduler";
