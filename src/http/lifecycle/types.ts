// src/http/lifecycle/types.ts
import type { Async } from "../../core/types/asyncEffect";
import type {
  HttpRequest,
  HttpWireResponse,
  HttpError,
  HttpClientFn,
  HttpMiddleware,
  MakeHttpConfig,
  HttpClientStats,
} from "../client";
import type { RetryPolicy } from "../retry/retry";

/**
 * Configuration for the deduplication layer.
 *
 * When enabled, the dedup layer collapses concurrent identical requests into a single
 * in-flight Async_Effect, sharing the response across all callers with the same Cache_Key.
 *
 * @property {function} [dedupKey] - Custom key function that computes a dedup key from an HttpRequest.
 *   When provided, overrides the default Cache_Key computation. Default: undefined (uses default key derivation).
 */
export type DedupConfig = {
  /** Custom key function. When provided, overrides default Cache_Key computation. */
  dedupKey?: (req: HttpRequest) => string;
  /** Internal lifecycle observer. Public callers should prefer LifecycleClientConfig.onEvent. */
  onEvent?: (event: { type: "dedup-hit" | "dedup-miss" | "dedup-active"; cacheKey?: string; active?: number }) => void;
};

/**
 * Configuration for the response cache layer.
 *
 * Controls how responses are stored and retrieved from the in-memory LRU cache.
 * Each cached entry is keyed by its deterministic Cache_Key.
 *
 * @property {number} [ttlSeconds] - Time-to-live in seconds for cached entries. Default: 60. Valid range: [1, 86400].
 * @property {number} [maxEntries] - Maximum number of cached entries before LRU eviction. Default: 1024. Valid range: >= 1.
 * @property {boolean} [staleWhileRevalidate] - When true, serves stale cache entries while revalidating in the background. Default: false.
 * @property {function} [cachePolicy] - Custom cache policy function that determines cacheability and optional TTL override for a given request/response pair. Default: undefined (uses built-in policy).
 * @property {string[]} [cacheRelevantHeaders] - Additional HTTP headers to include in Cache_Key computation beyond the defaults. Default: undefined (uses DEFAULT_CACHE_RELEVANT_HEADERS).
 */
export type CacheConfig = {
  /** Time-to-live in seconds. Default: 60. Range: [1, 86400]. */
  ttlSeconds?: number;
  /** Maximum number of cached entries. Default: 1024. Minimum: 1. */
  maxEntries?: number;
  /** Enable stale-while-revalidate. Default: false. */
  staleWhileRevalidate?: boolean;
  /** Custom cache policy function. */
  cachePolicy?: (req: HttpRequest, res: HttpWireResponse) => CachePolicyResult;
  /** Additional headers to include in Cache_Key computation. */
  cacheRelevantHeaders?: string[];
  /** Cache-specific observer for stale revalidation failures. */
  onEvent?: (event: { type: string; cacheKey?: string; error?: any }) => void;
  /** Internal lifecycle observer. Public callers should prefer LifecycleClientConfig.onEvent. */
  onLifecycleEvent?: (event: { type: "cache-hit" | "cache-miss" | "cache-eviction"; cacheKey?: string; count?: number }) => void;
};

/**
 * Result of a custom cache policy evaluation.
 *
 * Returned by the `cachePolicy` function in {@link CacheConfig} to control
 * whether a response should be stored in the cache and for how long.
 *
 * @property {boolean} cacheable - Whether the response should be cached. Required.
 * @property {number} [ttlSeconds] - Optional TTL override in seconds. When provided, takes precedence over the global CacheConfig ttlSeconds. Valid range: [1, 86400].
 */
export type CachePolicyResult = {
  /** Whether the response should be cached. */
  cacheable: boolean;
  /** Optional TTL override in seconds. */
  ttlSeconds?: number;
};

/**
 * Configuration for the priority scheduler layer.
 *
 * The priority scheduler orders outgoing requests by priority level and limits
 * concurrency to prevent overwhelming the downstream Wire_Client.
 *
 * @property {number} [concurrency] - Maximum concurrent requests dispatched by the priority scheduler. Default: 32. Valid range: >= 1.
 * @property {number} [queueTimeoutMs] - Queue timeout in milliseconds for priority-queued requests. When a request waits longer than this value, it is rejected. Default: undefined (no timeout).
 */
export type PriorityConfig = {
  /** Maximum concurrent requests dispatched by the priority scheduler. Default: 32. Valid range: >= 1. */
  concurrency?: number;
  /** Queue timeout in ms for priority-queued requests. Default: no timeout. */
  queueTimeoutMs?: number;
  /** Internal lifecycle observer. Public callers should prefer LifecycleClientConfig.onEvent. */
  onEvent?: (event: { type: "queue-enqueue" | "queue-dispatch"; priority: number }) => void;
};

/**
 * Configuration for creating a lifecycle client.
 *
 * Extends MakeHttpConfig with optional lifecycle layer configurations.
 * Each layer (dedup, cache, priority) can be configured with an options object
 * or explicitly disabled by setting it to `false`. When omitted, the layer is disabled
 * (zero-cost when disabled).
 *
 * @property {DedupConfig | false} [dedup] - Dedup layer configuration. Set to an object to enable with options, or `false` to explicitly disable. Default: undefined (disabled).
 * @property {CacheConfig | false} [cache] - Cache layer configuration. Set to an object to enable with options, or `false` to explicitly disable. Default: undefined (disabled).
 * @property {PriorityConfig | false} [priority] - Priority scheduler configuration. Set to an object to enable with options, or `false` to explicitly disable. Default: undefined (disabled).
 * @property {function} [onEvent] - Optional event observer callback invoked for each {@link LifecycleEvent} during request processing. Default: undefined.
 */
export type LifecycleClientConfig = MakeHttpConfig & {
  /** Dedup layer config. Set to `false` to explicitly disable. Default: undefined (disabled). */
  dedup?: DedupConfig | false;
  /** Cache layer config. Set to `false` to explicitly disable. Default: undefined (disabled). */
  cache?: CacheConfig | false;
  /** Priority scheduler config. Set to `false` to explicitly disable. Default: undefined (disabled). */
  priority?: PriorityConfig | false;
  /** Retry policy. Set to `false` to explicitly disable. Default: undefined (disabled). */
  retry?: RetryPolicy | false;
  /** Optional event observer for lifecycle events. */
  onEvent?: (event: LifecycleEvent) => void;
};

/**
 * The lifecycle client interface.
 *
 * A callable HTTP client function (Wire_Client wrapper) with additional lifecycle
 * management methods. Supports middleware composition via `.with()`, statistics
 * via `.stats()`, and bulk cancellation via `.cancelAll()`.
 *
 * @property {function} with - Apply middleware, returning a new LifecycleClient with the middleware applied.
 * @property {function} stats - Return a frozen snapshot of {@link LifecycleStats}.
 * @property {function} cancelAll - Cancel all in-flight and queued requests, returning an Async_Effect that resolves when cancellation is complete.
 * @property {object} cache - Cache management methods for manual invalidation.
 * @property {function} cache.invalidate - Invalidate a specific cache entry by its Cache_Key.
 * @property {function} cache.clear - Clear all cache entries.
 */
export type LifecycleClient = HttpClientFn & {
  /** Apply middleware, returning a new LifecycleClient with the middleware applied. */
  with: (mw: HttpMiddleware) => LifecycleClient;
  /** Return a frozen snapshot of lifecycle statistics. */
  stats: () => LifecycleStats;
  /** Cancel all in-flight and queued requests. Returns an Async_Effect that resolves when complete. */
  cancelAll: () => Async<unknown, never, void>;
  /** Cache management methods. */
  cache: {
    /** Invalidate a specific cache entry by Cache_Key. */
    invalidate: (key: string) => void;
    /** Clear all cache entries. */
    clear: () => void;
  };
};

/**
 * Lifecycle event types emitted during request processing.
 *
 * Each value represents a distinct point in the lifecycle pipeline:
 * - `"request-start"` — Emitted when a request enters the lifecycle pipeline.
 * - `"request-end"` — Emitted when a request completes (success or failure).
 * - `"cache-hit"` — Emitted when a response is served from the cache.
 * - `"cache-miss"` — Emitted when a request misses the cache and proceeds to the Wire_Client.
 * - `"dedup-hit"` — Emitted when a request is collapsed into an existing in-flight Async_Effect.
 * - `"dedup-miss"` — Emitted when a request initiates a new in-flight Async_Effect (no existing match).
 * - `"queue-enqueue"` — Emitted when a request is enqueued in the priority scheduler.
 * - `"queue-dispatch"` — Emitted when a queued request is dispatched to the Wire_Client.
 * - `"retry"` — Emitted when the retry middleware schedules another attempt.
 */
export type LifecycleEventType =
  | "request-start"
  | "request-end"
  | "cache-hit"
  | "cache-miss"
  | "dedup-hit"
  | "dedup-miss"
  | "queue-enqueue"
  | "queue-dispatch"
  | "retry";

/**
 * A lifecycle event emitted to the onEvent observer.
 *
 * Provides observability into the lifecycle pipeline by reporting events
 * as they occur during request processing.
 *
 * @property {LifecycleEventType} type - The type of lifecycle event. Required.
 * @property {number} timestamp - Timestamp in milliseconds (from `Date.now()`) when the event occurred. Required.
 * @property {string} [cacheKey] - The Cache_Key associated with the event, if applicable (present for cache and dedup events).
 * @property {number} [priority] - Priority level associated with the event, if applicable (present for queue events). Valid range: 0-9.
 * @property {number} [attempt] - Zero-based retry attempt, if applicable.
 * @property {number} [delayMs] - Retry delay in milliseconds, if applicable.
 * @property {number} [status] - HTTP status that triggered retry, if applicable.
 * @property {string} [errorTag] - HttpError tag that triggered retry, if applicable.
 */
export type LifecycleEvent = {
  /** The type of lifecycle event. */
  type: LifecycleEventType;
  /** Timestamp (ms) when the event occurred. */
  timestamp: number;
  /** Cache_Key associated with the event, if applicable. */
  cacheKey?: string;
  /** Priority level associated with the event, if applicable. Valid range: 0-9. */
  priority?: number;
  /** Zero-based retry attempt, if applicable. */
  attempt?: number;
  /** Retry delay in milliseconds, if applicable. */
  delayMs?: number;
  /** HTTP status that triggered retry, if applicable. */
  status?: number;
  /** HttpError tag that triggered retry, if applicable. */
  errorTag?: string;
};

/**
 * Lifecycle statistics snapshot.
 *
 * All counters start at zero and increase monotonically. Returned as a frozen
 * object by {@link LifecycleClient.stats}.
 *
 * @property {number} cacheHits - Number of cache hits (responses served from cache). Default: 0.
 * @property {number} cacheMisses - Number of cache misses (requests forwarded to Wire_Client). Default: 0.
 * @property {number} cacheEvictions - Number of cache evictions triggered by LRU policy. Default: 0.
 * @property {number} dedupHits - Number of dedup hits (requests collapsed into an existing in-flight Async_Effect). Default: 0.
 * @property {number} dedupActive - Number of currently active dedup groups (in-flight unique Cache_Keys). Default: 0.
 * @property {number} queueDepth - Current depth of the priority queue (requests waiting to be dispatched). Default: 0.
 * @property {number} requestsStarted - Total number of requests that entered the lifecycle pipeline. Default: 0.
 * @property {number} requestsCompleted - Total number of requests that completed successfully. Default: 0.
 * @property {number} requestsFailed - Total number of requests that failed with an error. Default: 0.
 * @property {number} retries - Total number of retry attempts scheduled. Default: 0.
 * @property {HttpClientStats} wire - Underlying Wire_Client statistics snapshot.
 */
export type LifecycleStats = {
  /** Number of cache hits. */
  cacheHits: number;
  /** Number of cache misses. */
  cacheMisses: number;
  /** Number of cache evictions (LRU). */
  cacheEvictions: number;
  /** Number of dedup hits (requests collapsed into existing in-flight Async_Effect). */
  dedupHits: number;
  /** Number of currently active dedup groups. */
  dedupActive: number;
  /** Current depth of the priority queue. */
  queueDepth: number;
  /** Total number of requests started. */
  requestsStarted: number;
  /** Total number of requests completed successfully. */
  requestsCompleted: number;
  /** Total number of requests that failed. */
  requestsFailed: number;
  /** Total number of retry attempts scheduled. */
  retries: number;
  /** Underlying Wire_Client stats. */
  wire: HttpClientStats;
};

/**
 * Per-request lifecycle options that can be passed alongside a request.
 *
 * Allows fine-grained control over lifecycle behavior on a per-request basis,
 * overriding the client-level configuration for individual requests.
 *
 * @property {number} [priority] - Priority level for this request. Valid range: 0-9 (0 = highest priority). Default: 5.
 * @property {string} [dedupKey] - Custom dedup key override for this request. When provided, overrides the computed Cache_Key for dedup purposes. Default: undefined.
 * @property {boolean} [noCache] - When true, bypasses the cache layer for this request (neither reads from nor writes to cache). Default: false.
 * @property {boolean} [noDedup] - When true, bypasses the dedup layer for this request (always creates a new in-flight Async_Effect). Default: false.
 */
export type LifecycleRequestOptions = {
  /** Priority level 0-9 (0 = highest). Default: 5. Valid range: 0-9. */
  priority?: number;
  /** Custom dedup key override for this request. */
  dedupKey?: string;
  /** Skip cache for this request. Default: false. */
  noCache?: boolean;
  /** Skip dedup for this request. Default: false. */
  noDedup?: boolean;
};
