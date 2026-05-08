// src/http/lifecycle/lifecycleClient.ts
import type { Async } from "../../core/types/asyncEffect";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import {
  makeHttp,
  type HttpClientFn,
  type HttpError,
  type HttpMiddleware,
  type HttpRequest,
  type HttpWireResponse,
  type MakeHttpConfig,
} from "../client";
import { withRetry } from "../retry/retry";
import { withDedup } from "./dedup";
import { withCache } from "./responseCache";
import { withPriority } from "./priorityScheduler";
import { computeDedupKey } from "./dedupKey";
import { LifecycleStatsTracker } from "./stats";
import { registerHttpEffect } from "../effectRunner";
import type {
  LifecycleClient,
  LifecycleClientConfig,
  LifecycleStats,
} from "./types";

/**
 * Validates that required globals (`fetch`, `AbortController`) are available.
 * Throws a descriptive error if any are missing.
 */
function validateGlobals(): void {
  if (typeof fetch === "undefined") {
    throw new Error(
      "makeLifecycleClient: global `fetch` is not available. " +
        "Ensure you are running in an environment with fetch support (Node.js 18+ or modern browser)."
    );
  }
  if (typeof AbortController === "undefined") {
    throw new Error(
      "makeLifecycleClient: global `AbortController` is not available. " +
        "Ensure you are running in an environment with AbortController support (Node.js 15+ or modern browser)."
    );
  }
}

/**
 * Extracts the MakeHttpConfig subset from a LifecycleClientConfig.
 */
function extractWireConfig(config: LifecycleClientConfig): MakeHttpConfig {
  const { dedup, cache, priority, retry, onEvent, ...wireConfig } = config;
  return wireConfig;
}

/**
 * Creates a lifecycle-aware HTTP client that composes deduplication, caching,
 * and priority scheduling layers on top of the Wire_Client.
 *
 * When no layers are configured, the client delegates directly to the underlying
 * Wire_Client with zero additional overhead (zero-cost when disabled). Each layer
 * is independently optional and can be set to `false` to explicitly disable.
 *
 * Layer composition order (outermost to innermost):
 * - User middleware (applied via `.with()`)
 * - Dedup layer (if enabled)
 * - Cache layer (if enabled)
 * - Priority layer (if enabled)
 * - Wire_Client (`makeHttp`)
 *
 * @param config - Lifecycle client configuration extending `MakeHttpConfig` with optional layer settings.
 *   - `config.baseUrl` — Base URL prepended to relative request paths.
 *   - `config.headers` — Default headers merged into every request.
 *   - `config.timeoutMs` — Request budget in milliseconds covering pool wait + fetch + body read.
 *   - `config.dedup` — Deduplication layer config or `false` to disable.
 *     - `config.dedup.dedupKey` — Custom key function overriding default key computation.
 *   - `config.cache` — Response cache layer config or `false` to disable.
 *     - `config.cache.ttlSeconds` — Time-to-live in seconds; integer between 1 and 86400 (default: 60).
 *     - `config.cache.maxEntries` — Maximum cached entries; integer >= 1 (default: 1024).
 *     - `config.cache.staleWhileRevalidate` — Enable stale-while-revalidate (default: false).
 *     - `config.cache.cachePolicy` — Custom cache policy function.
 *     - `config.cache.cacheRelevantHeaders` — Additional headers included in Cache_Key computation.
 *   - `config.priority` — Priority scheduler layer config or `false` to disable.
 *     - `config.priority.concurrency` — Maximum concurrent dispatched requests; integer >= 1 (default: 32).
 *     - `config.priority.queueTimeoutMs` — Queue timeout in milliseconds for priority-queued requests.
 *   - `config.onEvent` — Optional observer callback invoked on each lifecycle event.
 *
 * @returns A {@link LifecycleClient} instance that is callable as an `HttpClientFn` and exposes
 *   `.with()` for middleware composition, `.stats()` for observability, `.cancelAll()` for
 *   bulk cancellation, and `.cache` for cache management.
 *
 * @example
 * ```typescript
 * import { makeLifecycleClient } from "./index";
 * import type { LifecycleClientConfig } from "./index";
 *
 * const config: LifecycleClientConfig = {
 *   baseUrl: "https://api.example.com",
 *   cache: { ttlSeconds: 120, maxEntries: 512 },
 *   priority: { concurrency: 8 },
 *   dedup: {},
 * };
 *
 * const client = makeLifecycleClient(config);
 *
 * // Execute a GET request through all lifecycle layers
 * const response = client({ method: "GET", url: "/users" });
 * ```
 */
export function makeLifecycleClient(config: LifecycleClientConfig = {}): LifecycleClient {
  // Validate globals at construction time
  validateGlobals();

  const wireConfig = extractWireConfig(config);
  const wireClient = makeHttp(wireConfig);
  const activeControllers = new Set<AbortController>();
  const tracker = new LifecycleStatsTracker({
    onEvent: config.onEvent,
    wireStats: wireClient.stats,
  });

  const hasDedup = config.dedup !== undefined && config.dedup !== false;
  const hasCache = config.cache !== undefined && config.cache !== false;
  const hasPriority = config.priority !== undefined && config.priority !== false;
  const hasRetry = config.retry !== undefined && config.retry !== false;

  // Zero-cost path: no layers configured, delegate directly to wire client
  if (!hasDedup && !hasCache && !hasPriority && !hasRetry) {
    return buildLifecycleClient(wireClient, tracker, {
      cacheInvalidate: noopInvalidate,
      cacheClear: noopClear,
      cancelAll: () => cancelControllers(activeControllers),
      activeControllers,
    });
  }

  // Set up priority layer
  let priorityMiddleware: (HttpMiddleware & { queueDepth: () => number }) | undefined;
  if (hasPriority) {
    const priorityConfig = config.priority as Exclude<typeof config.priority, false | undefined>;
    priorityMiddleware = withPriority({
      ...priorityConfig,
      onEvent: (event) => {
        tracker.setQueueDepth(priorityMiddleware?.queueDepth() ?? 0);
        tracker.emit(event.type, { priority: event.priority });
      },
    });
  }

  // Set up cache layer
  let cacheLayer: { middleware: HttpMiddleware; invalidate: (key: string) => void; clear: () => void } | undefined;
  if (hasCache) {
    const cacheConfig = config.cache as Exclude<typeof config.cache, false | undefined>;
    cacheLayer = withCache({
      ...cacheConfig,
      baseUrl: wireConfig.baseUrl,
      onLifecycleEvent: (event) => {
        if (event.type === "cache-hit") tracker.cacheHit();
        if (event.type === "cache-miss") tracker.cacheMiss();
        if (event.type === "cache-eviction") tracker.cacheEviction();
        if (event.type === "cache-hit" || event.type === "cache-miss") {
          tracker.emit(event.type, { cacheKey: event.cacheKey });
        }
      },
    });
  }

  // Set up dedup layer
  let dedupMiddleware: HttpMiddleware | undefined;
  if (hasDedup) {
    const dedupConfig = config.dedup as Exclude<typeof config.dedup, false | undefined>;
    // If the user hasn't provided a custom dedupKey function and we have a baseUrl,
    // provide one that uses the baseUrl for proper URL resolution.
    const baseUrl = wireConfig.baseUrl ?? "";
    const effectiveDedupConfig = dedupConfig.dedupKey || !baseUrl
      ? dedupConfig
      : { ...dedupConfig, dedupKey: (req: HttpRequest) => computeDedupKey(req, baseUrl) };
    dedupMiddleware = withDedup({
      ...effectiveDedupConfig,
      onEvent: (event) => {
        if (event.type === "dedup-hit") tracker.dedupHit();
        if (event.type === "dedup-active") {
          tracker.setDedupActive(event.active ?? 0);
          return;
        }
        tracker.emit(event.type, { cacheKey: event.cacheKey });
      },
    });
  }

  // Compose layers: innermost to outermost
  // Wire → Priority → Retry → Cache → Dedup
  let composedFn: HttpClientFn = wireClient;

  if (priorityMiddleware) {
    composedFn = priorityMiddleware(composedFn);
  }

  // Retry is placed between priority and cache/dedup so one logical request can
  // retry through the queue while cache and dedup observe the final outcome.
  if (hasRetry) {
    const retryConfig = config.retry as Exclude<typeof config.retry, false | undefined>;
    composedFn = withRetry({
      ...retryConfig,
      onRetry: (event) => {
        tracker.retry();
        tracker.emit("retry", {
          attempt: event.attempt,
          delayMs: event.delayMs,
          status: event.status,
          errorTag: event.error?._tag,
        });
        retryConfig.onRetry?.(event);
      },
    })(composedFn);
  }

  if (cacheLayer) {
    composedFn = cacheLayer.middleware(composedFn);
  }

  if (dedupMiddleware) {
    composedFn = dedupMiddleware(composedFn);
  }

  return buildLifecycleClient(composedFn, tracker, {
    cacheInvalidate: cacheLayer?.invalidate ?? noopInvalidate,
    cacheClear: cacheLayer?.clear ?? noopClear,
    cancelAll: () => cancelControllers(activeControllers),
    activeControllers,
    queueDepth: priorityMiddleware?.queueDepth,
  });
}

/**
 * Canonical production HTTP client factory.
 *
 * Alias of {@link makeLifecycleClient}; kept as the recommended public name
 * for callers that want the stable wire -> priority -> retry -> cache -> dedup
 * lifecycle pipeline without importing lower-level building blocks.
 *
 * @param config - Lifecycle client configuration with optional wire, retry, cache, dedup, and priority settings.
 * @returns A lifecycle-aware HTTP client with stats, cache controls, middleware composition, and `cancelAll`.
 */
export function makeHttpClient(config: LifecycleClientConfig = {}): LifecycleClient {
  return makeLifecycleClient(config);
}

// --- Internal helpers ---

function noopInvalidate(_key: string): void {}
function noopClear(): void {}

type LifecycleClientInternals = {
  cacheInvalidate: (key: string) => void;
  cacheClear: () => void;
  cancelAll: () => Async<unknown, never, void>;
  activeControllers: Set<AbortController>;
  queueDepth?: () => number;
};

/**
 * Builds a LifecycleClient from a composed HttpClientFn and internal references.
 * The returned client is a callable function with lifecycle methods attached.
 */
function buildLifecycleClient(
  fn: HttpClientFn,
  tracker: LifecycleStatsTracker,
  internals: LifecycleClientInternals,
): LifecycleClient {
  const client: HttpClientFn = (req: HttpRequest) => trackRequest(fn, req, tracker, internals);

  const stats = (): LifecycleStats => {
    tracker.setQueueDepth(internals.queueDepth?.() ?? 0);
    return tracker.snapshot();
  };

  const withMw = (mw: HttpMiddleware): LifecycleClient => {
    // Apply middleware outermost (wraps the composed fn)
    const wrappedFn = mw(fn);
    return buildLifecycleClient(wrappedFn, tracker, internals);
  };

  const lifecycleClient = Object.assign(client, {
    with: withMw,
    stats,
    cancelAll: internals.cancelAll,
    cache: {
      invalidate: internals.cacheInvalidate,
      clear: internals.cacheClear,
    },
  });

  return lifecycleClient;
}

function cancelControllers(activeControllers: Set<AbortController>): Async<unknown, never, void> {
  for (const controller of Array.from(activeControllers)) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  return asyncSucceed(undefined) as Async<unknown, never, void>;
}

function trackRequest(
  fn: HttpClientFn,
  req: HttpRequest,
  tracker: LifecycleStatsTracker,
  internals: LifecycleClientInternals,
): Async<unknown, HttpError, HttpWireResponse> {
  return {
    _tag: "Async",
    register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
      const controller = new AbortController();
      const previousSignal = (req.init as any)?.signal as AbortSignal | undefined;
      let done = false;
      let abortedByPreviousSignal = false;
      let cancelInner: (() => void) | undefined;

      const abortFromPrevious = () => {
        abortedByPreviousSignal = true;
        try {
          controller.abort(previousSignal?.reason);
        } catch {
          controller.abort();
        }
        cancelInner?.();
      };

      if (previousSignal?.aborted) {
        abortFromPrevious();
      } else {
        previousSignal?.addEventListener("abort", abortFromPrevious, { once: true });
      }

      internals.activeControllers.add(controller);
      tracker.requestStarted();
      tracker.emit("request-start");

      const finish = (exit0: Exit<HttpError, HttpWireResponse>) => {
        if (done) return;
        done = true;
        const exit = abortedByPreviousSignal && exit0._tag === "Failure" && exit0.cause._tag === "Interrupt"
          ? { _tag: "Failure" as const, cause: Cause.fail({ _tag: "Abort" } satisfies HttpError) }
          : exit0;
        previousSignal?.removeEventListener("abort", abortFromPrevious);
        internals.activeControllers.delete(controller);

        if (exit._tag === "Success") {
          tracker.requestCompleted();
        } else {
          tracker.requestFailed();
        }

        tracker.emit("request-end");
        cb(exit);
      };

      const trackedReq: HttpRequest = {
        ...req,
        init: {
          ...(req.init ?? {}),
          signal: controller.signal,
        } as any,
      };

      try {
        cancelInner = registerHttpEffect(fn(trackedReq), env, finish);
      } catch (error) {
        finish({
          _tag: "Failure",
          cause: Cause.fail({ _tag: "FetchError", message: String(error) } satisfies HttpError),
        });
      }

      return () => {
        if (done) return;
        try {
          controller.abort();
        } catch {
          // ignore
        }
        if (cancelInner) {
          cancelInner();
        } else {
          finish({ _tag: "Failure", cause: Cause.interrupt() });
        }
      };
    },
  };
}
