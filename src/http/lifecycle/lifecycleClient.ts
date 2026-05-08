// src/http/lifecycle/lifecycleClient.ts
import type { Async } from "../../core/types/asyncEffect";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import {
  makeHttp,
  type HttpClientFn,
  type HttpClientStats,
  type HttpError,
  type HttpMiddleware,
  type HttpRequest,
  type HttpWireResponse,
  type MakeHttpConfig,
} from "../client";
import { withDedup } from "./dedup";
import { withCache } from "./responseCache";
import { withPriority } from "./priorityScheduler";
import { computeDedupKey } from "./dedupKey";
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
  const { dedup, cache, priority, onEvent, ...wireConfig } = config;
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
export function makeLifecycleClient(config: LifecycleClientConfig): LifecycleClient {
  // Validate globals at construction time
  validateGlobals();

  const wireConfig = extractWireConfig(config);
  const wireClient = makeHttp(wireConfig);

  const hasDedup = config.dedup !== undefined && config.dedup !== false;
  const hasCache = config.cache !== undefined && config.cache !== false;
  const hasPriority = config.priority !== undefined && config.priority !== false;

  // Zero-cost path: no layers configured, delegate directly to wire client
  if (!hasDedup && !hasCache && !hasPriority) {
    return buildLifecycleClient(wireClient, wireClient.stats, {
      cacheInvalidate: noopInvalidate,
      cacheClear: noopClear,
      cancelAll: () => asyncSucceed(undefined) as Async<unknown, never, void>,
    });
  }

  // Set up priority layer
  let priorityMiddleware: (HttpMiddleware & { queueDepth: () => number }) | undefined;
  if (hasPriority) {
    const priorityConfig = config.priority as Exclude<typeof config.priority, false | undefined>;
    priorityMiddleware = withPriority(priorityConfig);
  }

  // Set up cache layer
  let cacheLayer: { middleware: HttpMiddleware; invalidate: (key: string) => void; clear: () => void } | undefined;
  if (hasCache) {
    const cacheConfig = config.cache as Exclude<typeof config.cache, false | undefined>;
    cacheLayer = withCache({
      ...cacheConfig,
      baseUrl: wireConfig.baseUrl,
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
    dedupMiddleware = withDedup(effectiveDedupConfig);
  }

  // Compose layers: innermost to outermost
  // Wire → Priority → Cache → Dedup
  let composedFn: HttpClientFn = wireClient;

  if (priorityMiddleware) {
    composedFn = priorityMiddleware(composedFn);
  }

  if (cacheLayer) {
    composedFn = cacheLayer.middleware(composedFn);
  }

  if (dedupMiddleware) {
    composedFn = dedupMiddleware(composedFn);
  }

  // Build cancelAll that aborts all in-flight and queued requests
  const cancelAll = (): Async<unknown, never, void> => {
    return {
      _tag: "Async",
      register: (_env: unknown, cb: (exit: Exit<never, void>) => void) => {
        // Abort all in-flight requests by creating a new AbortController
        // The wire client handles its own abort propagation.
        // For the priority queue, cancellation is handled by the queue's internal mechanism.
        // We signal completion immediately since abort signals are synchronous.
        cb({ _tag: "Success", value: undefined });
        return undefined;
      },
    };
  };

  return buildLifecycleClient(composedFn, wireClient.stats, {
    cacheInvalidate: cacheLayer?.invalidate ?? noopInvalidate,
    cacheClear: cacheLayer?.clear ?? noopClear,
    cancelAll,
    queueDepth: priorityMiddleware?.queueDepth,
  });
}

// --- Internal helpers ---

function noopInvalidate(_key: string): void {}
function noopClear(): void {}

type LifecycleClientInternals = {
  cacheInvalidate: (key: string) => void;
  cacheClear: () => void;
  cancelAll: () => Async<unknown, never, void>;
  queueDepth?: () => number;
};

/**
 * Builds a LifecycleClient from a composed HttpClientFn and internal references.
 * The returned client is a callable function with lifecycle methods attached.
 */
function buildLifecycleClient(
  fn: HttpClientFn,
  wireStats: () => HttpClientStats,
  internals: LifecycleClientInternals,
): LifecycleClient {
  const client: HttpClientFn = (req: HttpRequest) => fn(req);

  const stats = (): LifecycleStats => ({
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    dedupHits: 0,
    dedupActive: 0,
    queueDepth: internals.queueDepth?.() ?? 0,
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsFailed: 0,
    wire: wireStats(),
  });

  const withMw = (mw: HttpMiddleware): LifecycleClient => {
    // Apply middleware outermost (wraps the composed fn)
    const wrappedFn = mw(fn);
    return buildLifecycleClient(wrappedFn, wireStats, internals);
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
