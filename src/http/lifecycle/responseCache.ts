// src/http/lifecycle/responseCache.ts
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { computeCacheKey } from "./cacheKey";
import { SAFE_METHODS } from "./dedupKey";
import { LRUCache } from "./lruCache";
import { now } from "./timing";

/**
 * Result of a custom cache policy function.
 */
export type CachePolicyResult = {
  cacheable: boolean;
  ttlSeconds?: number;
};

/**
 * Configuration for the response cache middleware.
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
  /** Additional headers to include in cache key computation. */
  cacheRelevantHeaders?: string[];
  /** Base URL needed for cache key computation. */
  baseUrl?: string;
  /** Optional event callback for structured failure events. */
  onEvent?: (event: { type: string; cacheKey: string; error?: any }) => void;
};

/**
 * Clamps a number to the given range.
 */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Safely emits an event via the onEvent callback, swallowing any errors.
 */
function safeEmit(
  onEvent: ((event: { type: string; cacheKey: string; error?: any }) => void) | undefined,
  event: { type: string; cacheKey: string; error?: any }
): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* swallow */
  }
}

/**
 * Minimal effect interpreter for running complex (FlatMap/Fold) effects.
 * Used for background SWR revalidation.
 */
function runEffect<E, A>(
  effect: Async<unknown, E, A>,
  env: unknown,
  cb: (exit: Exit<E, A>) => void
): void {
  switch (effect._tag) {
    case "Succeed":
      cb({ _tag: "Success", value: effect.value });
      return;
    case "Fail":
      cb({ _tag: "Failure", cause: Cause.fail(effect.error) });
      return;
    case "Sync":
      try {
        const value = effect.thunk(env);
        cb({ _tag: "Success", value });
      } catch (e) {
        cb({ _tag: "Failure", cause: Cause.die(e) as any });
      }
      return;
    case "Async":
      effect.register(env, cb);
      return;
    case "FlatMap":
      runEffect(effect.first, env, (exit) => {
        if (exit._tag === "Failure") {
          cb(exit as any);
          return;
        }
        try {
          const next = effect.andThen(exit.value);
          runEffect(next, env, cb);
        } catch (e) {
          cb({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      });
      return;
    case "Fold":
      runEffect(effect.first, env, (exit) => {
        if (exit._tag === "Success") {
          try {
            const next = effect.onSuccess(exit.value);
            runEffect(next, env, cb);
          } catch (e) {
            cb({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        } else {
          if (exit.cause._tag === "Fail") {
            try {
              const next = effect.onFailure(exit.cause.error);
              runEffect(next, env, cb);
            } catch (e) {
              cb({ _tag: "Failure", cause: Cause.die(e) as any });
            }
          } else {
            cb(exit as any);
          }
        }
      });
      return;
    case "Fork":
      cb({ _tag: "Success", value: undefined as any });
      return;
  }
}

/**
 * Creates a response cache middleware that stores and serves previously fetched
 * responses based on configurable cache policies.
 *
 * Features:
 * - LRU eviction when maxEntries is exceeded
 * - Per-entry TTL with configurable default
 * - Stale-while-revalidate support
 * - Custom cache policy function for cacheability and TTL override
 * - Only caches safe methods (GET, HEAD, OPTIONS) by default
 * - Exposes `invalidate(key)` and `clear()` for manual cache control
 *
 * @param config - Optional cache configuration object.
 *   - `ttlSeconds`: Time-to-live per entry in seconds, clamped to [1, 86400]. Default: 60.
 *   - `maxEntries`: Maximum cached entries, minimum 1. Default: 1024.
 *   - `staleWhileRevalidate`: When true, serves stale entries while refreshing in background. Default: false.
 *   - `cachePolicy`: Custom function to determine cacheability and per-entry TTL override.
 *   - `cacheRelevantHeaders`: Additional headers included in Cache_Key computation.
 *   - `baseUrl`: Base URL for Cache_Key computation.
 *   - `onEvent`: Callback for structured cache events (e.g., revalidation failures).
 * @returns An object containing:
 *   - `middleware`: An HttpMiddleware that wraps the next Wire_Client with caching logic.
 *   - `invalidate(key)`: Removes a specific entry from the cache by its Cache_Key.
 *   - `clear()`: Removes all entries from the cache.
 *
 * @example
 * ```typescript
 * import { withCache } from "./responseCache";
 *
 * // Basic usage with defaults (60s TTL, 1024 max entries)
 * const { middleware, invalidate, clear } = withCache();
 *
 * // Custom TTL and max entries
 * const cache = withCache({
 *   ttlSeconds: 300,
 *   maxEntries: 512,
 *   staleWhileRevalidate: true,
 * });
 *
 * // Manually invalidate a cached entry
 * cache.invalidate("GET|https://api.example.com/users");
 * ```
 */
export function withCache(config?: CacheConfig): {
  middleware: HttpMiddleware;
  invalidate: (key: string) => void;
  clear: () => void;
} {
  const ttlSeconds = clamp(config?.ttlSeconds ?? 60, 1, 86400);
  const ttlMs = ttlSeconds * 1000;
  const maxEntries = Math.max(1, Math.floor(config?.maxEntries ?? 1024));
  const staleWhileRevalidate = config?.staleWhileRevalidate ?? false;
  const cachePolicy = config?.cachePolicy;
  const cacheRelevantHeaders = config?.cacheRelevantHeaders ?? [];
  const baseUrl = config?.baseUrl ?? "";
  const onEvent = config?.onEvent;

  const cache = new LRUCache<HttpWireResponse>({ maxEntries });

  // Track in-flight SWR revalidation keys to prevent duplicates
  const revalidating = new Set<string>();

  const invalidate = (key: string): void => {
    cache.delete(key);
  };

  const clear = (): void => {
    cache.clear();
  };

  const middleware: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      const method = req.method.toUpperCase();

      // Non-safe methods bypass cache entirely (unless cachePolicy overrides)
      if (!SAFE_METHODS.has(method) && !cachePolicy) {
        return next(req);
      }

      // Compute cache key
      const key = computeCacheKey(req, baseUrl, cacheRelevantHeaders);

      return {
        _tag: "Async",
        register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          // Check cache for a hit
          const cached = cache.get(key);

          if (cached !== undefined) {
            // Cache hit — return immediately
            cb({ _tag: "Success", value: cached });
            return;
          }

          // Cache miss — forward to next
          const innerEffect = next(req);

          // Run the inner effect and handle the response
          let innerCancel: (() => void) | void = undefined;

          if (innerEffect._tag === "Succeed") {
            storeIfCacheable(req, innerEffect.value, key);
            cb({ _tag: "Success", value: innerEffect.value });
          } else if (innerEffect._tag === "Fail") {
            cb({ _tag: "Failure", cause: Cause.fail(innerEffect.error) });
          } else if (innerEffect._tag === "Async") {
            innerCancel = innerEffect.register(env, (exit: Exit<HttpError, HttpWireResponse>) => {
              if (exit._tag === "Success") {
                storeIfCacheable(req, exit.value, key);
              }
              cb(exit);
            });
          } else {
            // Complex effect (FlatMap, Fold, etc.)
            runEffect(innerEffect, env, (exit: Exit<HttpError, HttpWireResponse>) => {
              if (exit._tag === "Success") {
                storeIfCacheable(req, exit.value, key);
              }
              cb(exit);
            });
          }

          // Return cancellation function
          return typeof innerCancel === "function" ? innerCancel : undefined;
        },
      };
    };
  };

  /**
   * Determines if a response is cacheable and stores it if so.
   */
  function storeIfCacheable(req: HttpRequest, res: HttpWireResponse, key: string): void {
    const method = req.method.toUpperCase();

    if (cachePolicy) {
      const result = cachePolicy(req, res);
      if (!result.cacheable) return;
      const entryTtlMs = result.ttlSeconds !== undefined
        ? clamp(result.ttlSeconds, 1, 86400) * 1000
        : ttlMs;
      cache.set(key, res, entryTtlMs);
      return;
    }

    // Default: only cache safe methods
    if (!SAFE_METHODS.has(method)) return;

    cache.set(key, res, ttlMs);
  }

  /**
   * Triggers a background SWR revalidation for the given key.
   */
  function triggerRevalidation(
    next: HttpClientFn,
    req: HttpRequest,
    key: string
  ): void {
    if (revalidating.has(key)) return; // Prevent duplicate revalidations

    revalidating.add(key);

    const innerEffect = next(req);

    const handleExit = (exit: Exit<HttpError, HttpWireResponse>) => {
      revalidating.delete(key);

      if (exit._tag === "Success") {
        storeIfCacheable(req, exit.value, key);
      } else {
        // Revalidation failed — retain stale entry, emit event
        safeEmit(onEvent, {
          type: "revalidation-failure",
          cacheKey: key,
          error: exit.cause._tag === "Fail" ? exit.cause.error : undefined,
        });
      }
    };

    if (innerEffect._tag === "Succeed") {
      handleExit({ _tag: "Success", value: innerEffect.value });
    } else if (innerEffect._tag === "Fail") {
      handleExit({ _tag: "Failure", cause: Cause.fail(innerEffect.error) });
    } else if (innerEffect._tag === "Async") {
      innerEffect.register(undefined, handleExit);
    } else {
      runEffect(innerEffect, undefined, handleExit);
    }
  }

  // --- SWR-aware middleware variant ---
  // When staleWhileRevalidate is enabled, entries are stored with a very large TTL
  // in the LRU cache (so they aren't evicted on expiration). Real expiration is
  // tracked in a separate expirationMap, allowing stale entries to be served immediately
  // while background revalidation refreshes the cache.

  // Metadata for SWR: tracks real expiration time per key
  const expirationMap = new Map<string, number>();

  // SWR middleware variant
  const swrMiddleware: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      const method = req.method.toUpperCase();

      // Non-safe methods bypass cache entirely (unless cachePolicy overrides)
      if (!SAFE_METHODS.has(method) && !cachePolicy) {
        return next(req);
      }

      // Compute cache key
      const key = computeCacheKey(req, baseUrl, cacheRelevantHeaders);

      return {
        _tag: "Async",
        register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          // With SWR enabled, entries are stored with infinite TTL in the LRU.
          // We check our own expirationMap for real expiration.
          const cached = cache.get(key);

          if (cached !== undefined) {
            const expiresAt = expirationMap.get(key);

            if (expiresAt !== undefined && now() < expiresAt) {
              // Fresh cache hit
              cb({ _tag: "Success", value: cached });
              return;
            }

            // Stale entry — return it immediately and trigger background revalidation
            cb({ _tag: "Success", value: cached });
            triggerRevalidation(next, req, key);
            return;
          }

          // Cache miss — forward to next
          const innerEffect = next(req);
          let innerCancel: (() => void) | void = undefined;

          const handleSuccess = (res: HttpWireResponse) => {
            swrStoreIfCacheable(req, res, key);
          };

          if (innerEffect._tag === "Succeed") {
            handleSuccess(innerEffect.value);
            cb({ _tag: "Success", value: innerEffect.value });
          } else if (innerEffect._tag === "Fail") {
            cb({ _tag: "Failure", cause: Cause.fail(innerEffect.error) });
          } else if (innerEffect._tag === "Async") {
            innerCancel = innerEffect.register(env, (exit: Exit<HttpError, HttpWireResponse>) => {
              if (exit._tag === "Success") {
                handleSuccess(exit.value);
              }
              cb(exit);
            });
          } else {
            runEffect(innerEffect, env, (exit: Exit<HttpError, HttpWireResponse>) => {
              if (exit._tag === "Success") {
                handleSuccess(exit.value);
              }
              cb(exit);
            });
          }

          return typeof innerCancel === "function" ? innerCancel : undefined;
        },
      };
    };
  };

  /**
   * Stores a response in the cache with SWR-aware TTL management.
   * When SWR is enabled, stores with a very large TTL in the LRU and
   * tracks real expiration in the expirationMap.
   */
  function swrStoreIfCacheable(req: HttpRequest, res: HttpWireResponse, key: string): void {
    const method = req.method.toUpperCase();
    let entryTtlMs = ttlMs;

    if (cachePolicy) {
      const result = cachePolicy(req, res);
      if (!result.cacheable) return;
      entryTtlMs = result.ttlSeconds !== undefined
        ? clamp(result.ttlSeconds, 1, 86400) * 1000
        : ttlMs;
    } else if (!SAFE_METHODS.has(method)) {
      return;
    }

    // Store with a very large TTL in the LRU (effectively infinite for SWR)
    // The real expiration is tracked in expirationMap
    const lruTtl = Number.MAX_SAFE_INTEGER;
    cache.set(key, res, lruTtl);
    expirationMap.set(key, now() + entryTtlMs);
  }

  // SWR-aware invalidate that also cleans up the expiration map
  const swrInvalidate = (key: string): void => {
    cache.delete(key);
    expirationMap.delete(key);
  };

  const swrClear = (): void => {
    cache.clear();
    expirationMap.clear();
  };

  // Choose the appropriate middleware based on SWR config
  if (staleWhileRevalidate) {
    return {
      middleware: swrMiddleware,
      invalidate: swrInvalidate,
      clear: swrClear,
    };
  }

  return {
    middleware,
    invalidate,
    clear,
  };
}
