// src/http/lifecycle/stats.ts
import type { LifecycleStats, LifecycleEvent, LifecycleEventType } from "./types";
import type { HttpClientStats } from "../client";
import { now } from "./timing";

/**
 * Tracks lifecycle statistics for the HTTP Lifecycle Client.
 *
 * All counters start at zero and increase monotonically. The tracker also
 * provides event emission for observability, wrapping the user-supplied
 * `onEvent` callback in a try-catch so that callback errors never disrupt
 * request processing.
 *
 * Use the `snapshot()` method to obtain a frozen point-in-time view of all
 * statistics, including wire-level stats from the underlying HTTP client.
 *
 * @example
 * ```typescript
 * import { LifecycleStatsTracker } from "./stats";
 *
 * const tracker = new LifecycleStatsTracker({
 *   onEvent: (event) => console.log(event.type),
 *   wireStats: () => ({ requestCount: 0, errorCount: 0 }),
 * });
 * tracker.cacheHit();
 * const stats = tracker.snapshot();
 * console.log(stats.cacheHits); // 1
 * ```
 */
export class LifecycleStatsTracker {
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _cacheEvictions = 0;
  private _dedupHits = 0;
  private _dedupActive = 0;
  private _queueDepth = 0;
  private _requestsStarted = 0;
  private _requestsCompleted = 0;
  private _requestsFailed = 0;
  private _retries = 0;
  private _batchDispatches = 0;
  private _batchedRequests = 0;
  private readonly _onEvent: ((event: LifecycleEvent) => void) | undefined;
  private readonly _wireStats: () => HttpClientStats;

  /**
   * Creates a new lifecycle stats tracker.
   *
   * @param opts - Configuration options for the tracker.
   * @param opts.onEvent - Optional callback invoked on each lifecycle event.
   *   Errors thrown by this callback are silently discarded.
   * @param opts.wireStats - A function returning the current wire-level HTTP client stats.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({
   *   wireStats: () => ({ requestCount: 0, errorCount: 0 }),
   * });
   * ```
   */
  constructor(opts: {
    onEvent?: (event: LifecycleEvent) => void;
    wireStats: () => HttpClientStats;
  }) {
    this._onEvent = opts.onEvent;
    this._wireStats = opts.wireStats;
  }

  // --- Increment methods ---

  /**
   * Records a cache hit. Increments the cache hit counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.cacheHit();
   * ```
   */
  cacheHit(): void {
    this._cacheHits++;
  }

  /**
   * Records a cache miss. Increments the cache miss counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.cacheMiss();
   * ```
   */
  cacheMiss(): void {
    this._cacheMisses++;
  }

  /**
   * Records a cache eviction. Increments the cache eviction counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.cacheEviction();
   * ```
   */
  cacheEviction(): void {
    this._cacheEvictions++;
  }

  /**
   * Records a dedup hit (a request that joined an in-flight duplicate).
   * Increments the dedup hit counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.dedupHit();
   * ```
   */
  dedupHit(): void {
    this._dedupHits++;
  }

  /**
   * Sets the current number of active dedup groups.
   *
   * @param n - The current count of active dedup groups. Must be >= 0.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.setDedupActive(3);
   * ```
   */
  setDedupActive(n: number): void {
    this._dedupActive = n;
  }

  /**
   * Sets the current priority queue depth.
   *
   * @param n - The current number of entries in the priority queue. Must be >= 0.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.setQueueDepth(5);
   * ```
   */
  setQueueDepth(n: number): void {
    this._queueDepth = n;
  }

  /**
   * Records that a request has started. Increments the requests started counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.requestStarted();
   * ```
   */
  requestStarted(): void {
    this._requestsStarted++;
  }

  /**
   * Records that a request has completed successfully.
   * Increments the requests completed counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.requestCompleted();
   * ```
   */
  requestCompleted(): void {
    this._requestsCompleted++;
  }

  /**
   * Records that a request has failed.
   * Increments the requests failed counter by 1.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({ wireStats: () => ({ requestCount: 0, errorCount: 0 }) });
   * tracker.requestFailed();
   * ```
   */
  requestFailed(): void {
    this._requestsFailed++;
  }

  retry(): void {
    this._retries++;
  }

  /**
   * Records a batch dispatch. Increments the batch dispatches counter by 1.
   */
  batchDispatch(): void {
    this._batchDispatches++;
  }

  /**
   * Records requests that were coalesced into a batch.
   * @param count - The number of individual requests in the batch.
   */
  batchedRequests(count: number): void {
    this._batchedRequests += count;
  }

  // --- Event emission ---

  /**
   * Emits a lifecycle event to the registered `onEvent` callback.
   *
   * The callback is wrapped in a try-catch so that any exception thrown by
   * the callback is silently discarded and request processing continues
   * unaffected. If no `onEvent` callback was provided, this is a no-op.
   *
   * @param type - The lifecycle event type to emit (e.g., `"cache-hit"`, `"request-start"`).
   * @param extra - Optional additional event data.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({
   *   onEvent: (event) => console.log(event.type, event.timestamp),
   *   wireStats: () => ({ requestCount: 0, errorCount: 0 }),
   * });
   * tracker.emit("cache-hit", { cacheKey: "GET|/api/users" });
   * ```
   */
  emit(
    type: LifecycleEventType,
    extra?: {
      cacheKey?: string;
      priority?: number;
      batchKey?: string;
      batchSize?: number;
      attempt?: number;
      delayMs?: number;
      status?: number;
      errorTag?: string;
    },
  ): void {
    if (!this._onEvent) return;
    try {
      const event: LifecycleEvent = {
        type,
        timestamp: now(),
        ...extra,
      };
      this._onEvent(event);
    } catch {
      // Swallow errors from onEvent callback (Requirement 8.6)
    }
  }

  // --- Snapshot ---

  /**
   * Returns a frozen snapshot of all lifecycle statistics including wire stats.
   *
   * The returned object is frozen (immutable) and represents a point-in-time
   * view of all counters and gauges.
   *
   * @returns A frozen `LifecycleStats` object containing all current statistics.
   *
   * @example
   * ```typescript
   * import { LifecycleStatsTracker } from "./stats";
   *
   * const tracker = new LifecycleStatsTracker({
   *   wireStats: () => ({ requestCount: 10, errorCount: 1 }),
   * });
   * tracker.cacheHit();
   * tracker.cacheHit();
   * const stats = tracker.snapshot();
   * console.log(stats.cacheHits); // 2
   * ```
   */
  snapshot(): LifecycleStats {
    return Object.freeze({
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheEvictions: this._cacheEvictions,
      dedupHits: this._dedupHits,
      dedupActive: this._dedupActive,
      queueDepth: this._queueDepth,
      requestsStarted: this._requestsStarted,
      requestsCompleted: this._requestsCompleted,
      requestsFailed: this._requestsFailed,
      retries: this._retries,
      batchDispatches: this._batchDispatches,
      batchedRequests: this._batchedRequests,
      wire: this._wireStats(),
    });
  }
}
