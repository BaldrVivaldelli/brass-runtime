# HTTP Lifecycle Client

## Introduction

The HTTP Lifecycle Client is a composable HTTP client that wraps the low-level Wire\_Client (`makeHttp`) with three optional processing layers:

- **Deduplication** — Collapses concurrent identical requests into a single in-flight `Async` effect, sharing the response across all callers with the same cache key.
- **Caching** — Stores responses in an in-memory LRU cache keyed by a deterministic cache key, serving subsequent requests without hitting the network.
- **Priority Scheduling** — Orders outgoing requests by priority level (0–9) and limits concurrency to prevent overwhelming the downstream Wire\_Client.

Each layer is independently optional. When a layer is not configured, it is completely bypassed with zero additional overhead ("zero-cost when disabled"). Layers compose in a fixed order — user middleware (outermost), then dedup, then cache, then priority, then the Wire\_Client (innermost).

The lifecycle client is callable as a standard `HttpClientFn`, meaning it accepts an `HttpRequest` and returns an `Async<unknown, HttpError, HttpWireResponse>`. It additionally exposes `.with()` for middleware composition, `.stats()` for observability, `.cancelAll()` for bulk cancellation, and `.cache` for manual cache management.

## Installation & Import

The lifecycle client is available from the `brass-runtime/http` package entry point:

```typescript
import {
  makeLifecycleClient,
  type LifecycleClientConfig,
  type LifecycleClient,
} from "brass-runtime/http";
```

You can also import individual utilities directly from the lifecycle module:

```typescript
import {
  computeCacheKey,
  parseCacheKey,
  withAuth,
  withLogging,
  withResponseTransform,
} from "brass-runtime/http";
```

## Quick Start

Create a lifecycle client with default configuration and execute a GET request:

```typescript
import { makeLifecycleClient } from "brass-runtime/http";
import type { LifecycleClientConfig } from "brass-runtime/http";
import { unsafeRunAsync } from "brass-runtime/core";

// Configure the client with a base URL and enable caching
const config: LifecycleClientConfig = {
  baseUrl: "https://api.example.com",
  cache: { ttlSeconds: 60, maxEntries: 256 },
};

// Create the lifecycle client
const client = makeLifecycleClient(config);

// Execute a GET request — returns an Async<unknown, HttpError, HttpWireResponse>
const effect = client({ method: "GET", url: "/users" });

// Run the effect and handle the result
unsafeRunAsync(effect, undefined, (exit) => {
  if (exit._tag === "Success") {
    console.log("Status:", exit.value.status);
    console.log("Body:", exit.value.bodyText);
  } else {
    console.error("Request failed:", exit.cause);
  }
});
```

## Observability

The lifecycle client provides two complementary observability mechanisms: a statistics snapshot and a real-time event callback.

### `stats()`

Call `client.stats()` to retrieve a frozen snapshot of all lifecycle counters. The returned `LifecycleStats` object includes cache hits/misses/evictions, dedup hits, active dedup groups, queue depth, request counts (started, completed, failed), and the underlying Wire\_Client stats.

```typescript
import { makeLifecycleClient } from "brass-runtime/http";

const client = makeLifecycleClient({
  baseUrl: "https://api.example.com",
  cache: { ttlSeconds: 30 },
});

// After some requests...
const snapshot = client.stats();
console.log("Cache hits:", snapshot.cacheHits);
console.log("Cache misses:", snapshot.cacheMisses);
console.log("Dedup hits:", snapshot.dedupHits);
console.log("Queue depth:", snapshot.queueDepth);
console.log("Requests started:", snapshot.requestsStarted);
```

### `onEvent` Callback

Pass an `onEvent` callback in the client configuration to receive real-time `LifecycleEvent` notifications as requests flow through the pipeline. Each event includes a `type`, a `timestamp` (ms), and optional contextual fields (`cacheKey`, `priority`).

```typescript
import { makeLifecycleClient } from "brass-runtime/http";
import type { LifecycleEvent } from "brass-runtime/http";

const client = makeLifecycleClient({
  baseUrl: "https://api.example.com",
  cache: { ttlSeconds: 60 },
  dedup: {},
  priority: { concurrency: 16 },
  onEvent: (event: LifecycleEvent) => {
    console.log(`[${event.type}] at ${event.timestamp}`, event.cacheKey ?? "");
  },
});
```

### `LifecycleEventType` Values

The following event types are emitted during request processing:

| Event Type | Description |
|---|---|
| `request-start` | Emitted when a request enters the lifecycle pipeline |
| `request-end` | Emitted when a request completes (success or failure) |
| `cache-hit` | Emitted when a response is served from the cache |
| `cache-miss` | Emitted when a request misses the cache and proceeds downstream |
| `dedup-hit` | Emitted when a request is collapsed into an existing in-flight Async\_Effect |
| `dedup-miss` | Emitted when a request initiates a new in-flight Async\_Effect |
| `queue-enqueue` | Emitted when a request is enqueued in the priority scheduler |
| `queue-dispatch` | Emitted when a queued request is dispatched to the Wire\_Client |

## Performance

The lifecycle client is designed with a **zero-cost when disabled** guarantee: when a layer (dedup, cache, or priority) is not configured, it is completely bypassed with no additional overhead. The lifecycle client with no layers enabled performs within 5% of a plain Wire\_Client call.

### Benchmark Suite

Performance claims are validated by the lifecycle benchmark suite. Run the benchmarks with:

```bash
npm run benchmark -- lifecycle
```

This executes all `*lifecycle*.bench.ts` files in the `src/benchmarks/` directory, measuring per-layer overhead in isolation and in combination.

### Results

| Configuration | p50 (ms) | p99 (ms) |
|---|---|---|
| Baseline (no layers) | 0.105 | 0.369 |
| Dedup only (unique keys) | 0.001 | 0.002 |
| Cache only (hit) | 0.033 | 0.046 |
| Priority only (uncontended) | 0.057 | 0.095 |
| All layers combined (unique) | 0.058 | 0.117 |

> Results measured against an in-process mock handler with zero network I/O on linux-x64, Node v22.21.1.

## Middleware

The lifecycle client supports composable middleware via the `.with()` method. Middleware wraps the client's request pipeline, allowing you to inject headers, log events, or transform responses without modifying the core client logic. Multiple middleware can be chained — each `.with()` call returns a new client instance with the middleware applied outermost.

### withAuth

Injects a Bearer token into the `Authorization` header on every request. The token is obtained asynchronously via a provider function, supporting token rotation and refresh flows.

```typescript
import { makeLifecycleClient, withAuth } from "brass-runtime/http";
import { asyncSucceed } from "brass-runtime/core";

// Create a client with auth middleware
const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
  .with(withAuth(() => asyncSucceed("my-secret-token")));

// All requests now include Authorization: Bearer my-secret-token
const effect = client({ method: "GET", url: "/users" });
```

The `tokenProvider` is called on every request, so you can return a fresh token each time (e.g., from a refresh flow). If the token provider fails, the error propagates to the caller unchanged.

### withLogging

Instruments requests with lifecycle logging. The logger callback receives a `LogEvent` at three phases: `"request"` (before send), `"response"` (on success), and `"error"` (on failure). Duration is measured in milliseconds.

```typescript
import { makeLifecycleClient, withLogging } from "brass-runtime/http";
import type { LogEvent } from "brass-runtime/http";

const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
  .with(withLogging((event: LogEvent) => {
    console.log(`[${event.phase}] ${event.req.method} ${event.req.url} ${event.durationMs ?? ""}ms`);
  }));

// Logs: [request] GET /health
// Logs: [response] GET /health 42ms
const effect = client({ method: "GET", url: "/health" });
```

If the logger callback throws, the error is silently swallowed to avoid disrupting the request pipeline.

### withResponseTransform

Transforms HTTP responses after retrieval. The transform function receives the response and the original request, and returns a modified `HttpWireResponse`. This runs on every access, including cached responses.

```typescript
import { makeLifecycleClient, withResponseTransform } from "brass-runtime/http";

const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
  .with(withResponseTransform((res, req) => ({
    ...res,
    headers: { ...res.headers, "x-request-url": req.url },
  })));

// Responses now include the x-request-url header
const effect = client({ method: "GET", url: "/data" });
```

If the transform function throws, the error is propagated as a `FetchError`.

## Cache Key

The lifecycle client uses a deterministic cache key to identify equivalent requests for both the dedup and cache layers. The key is computed from four components — HTTP method, resolved URL, cache-relevant headers, and request body — concatenated with a null character (`\u0000`) separator.

### Deterministic Computation

Cache keys are deterministic: the same request always produces the same key, regardless of header insertion order or URL format. The computation:

1. Normalizes the HTTP method to uppercase
2. Resolves the request URL against the configured `baseUrl`
3. Filters headers to only cache-relevant ones (default: `accept`, `authorization`, `content-type`), sorts them alphabetically, and formats as `key:value` pairs
4. Appends the request body (or empty string if absent)

This ensures that `GET /users` and `GET /users` with the same headers always map to the same cache entry, while `GET /users` with `Accept: text/html` maps to a different entry than `Accept: application/json`.

### computeCacheKey

Computes a cache key string from a request:

```typescript
import { computeCacheKey } from "brass-runtime/http";

const key = computeCacheKey(
  { method: "GET", url: "/users", headers: { accept: "application/json" } },
  "https://api.example.com"
);
```

You can include additional headers in the key computation via the `extraHeaders` parameter:

```typescript
const key = computeCacheKey(
  { method: "GET", url: "/users", headers: { accept: "application/json", "x-tenant": "acme" } },
  "https://api.example.com",
  ["x-tenant"]
);
```

### parseCacheKey

Parses a cache key string back into its component parts. This enables round-trip fidelity — you can compute a key and then inspect its components:

```typescript
import { computeCacheKey, parseCacheKey } from "brass-runtime/http";

const key = computeCacheKey(
  { method: "POST", url: "/data", headers: { "content-type": "application/json" }, body: '{"id":1}' },
  "https://api.example.com"
);

const parts = parseCacheKey(key);
// parts.method === "POST"
// parts.resolvedUrl === "https://api.example.com/data"
// parts.headers === { "content-type": "application/json" }
// parts.body === '{"id":1}'
```

Round-trip parsing is guaranteed: `parseCacheKey(computeCacheKey(req, baseUrl))` always reconstructs the original components. The null character separator ensures unambiguous splitting even when the body contains special characters.

## Cancellation

The lifecycle client supports three levels of cancellation: individual request cancellation, dedup group cancellation, and bulk cancellation via `cancelAll()`.

### Individual Request Cancellation

Each request returns an `Async` effect. When you cancel the effect (via the cancellation function returned by `register`), only that specific request is aborted. If the request is part of a dedup group, the group continues serving other callers.

```typescript
const effect = client({ method: "GET", url: "/slow-endpoint" });

// Register the effect and get the cancel function
const cancel = effect.register(undefined, (exit) => {
  if (exit._tag === "Failure" && exit.cause._tag === "Interrupt") {
    console.log("Request was cancelled");
  }
});

// Cancel the individual request
if (cancel) cancel();
```

### Dedup Group Cancellation

When deduplication is enabled, concurrent identical requests share a single in-flight network call. Cancellation is ref-counted: each caller that cancels decrements the reference count. The underlying network request is only aborted when all callers in the dedup group have cancelled (ref count reaches zero).

This means cancelling one caller in a dedup group does not affect other callers waiting for the same response. Only when the last interested caller cancels is the underlying fetch aborted via `AbortController`.

### cancelAll()

The `cancelAll()` method provides bulk cancellation of all in-flight and queued requests:

```typescript
const client = makeLifecycleClient({
  baseUrl: "https://api.example.com",
  dedup: {},
  cache: { ttlSeconds: 60 },
  priority: { concurrency: 8 },
});

// Fire off multiple requests
const effect1 = client({ method: "GET", url: "/users" });
const effect2 = client({ method: "GET", url: "/posts" });

// Cancel everything — all in-flight requests and queued priority items
const cancelEffect = client.cancelAll();
```

`cancelAll()` returns an `Async` effect that resolves once cancellation signals have been dispatched. This is useful for cleanup during application shutdown or when navigating away from a page.

## Configuration Reference

### LifecycleClientConfig

Extends `MakeHttpConfig` with optional lifecycle layer configurations. Each layer is independently optional — when omitted or set to `false`, the layer is completely bypassed with zero overhead.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | `undefined` | Base URL prepended to relative request paths. Inherited from `MakeHttpConfig`. |
| `headers` | `Record<string, string>` | `undefined` | Default headers merged into every request. Inherited from `MakeHttpConfig`. |
| `timeoutMs` | `number` | `undefined` (disabled) | Request budget in milliseconds covering pool wait + fetch + body read. |
| `pool` | `false \| HttpPoolConfig` | `false` (disabled) | Downstream pool/concurrency limiter. Inherited from `MakeHttpConfig`. |
| `dedup` | `DedupConfig \| false` | `undefined` (disabled) | Dedup layer configuration. Set to an object to enable, `false` to explicitly disable. |
| `cache` | `CacheConfig \| false` | `undefined` (disabled) | Cache layer configuration. Set to an object to enable, `false` to explicitly disable. |
| `priority` | `PriorityConfig \| false` | `undefined` (disabled) | Priority scheduler configuration. Set to an object to enable, `false` to explicitly disable. |
| `onEvent` | `(event: LifecycleEvent) => void` | `undefined` | Optional event observer callback invoked for each lifecycle event during request processing. |

### DedupConfig

Configuration for the deduplication layer. When enabled, concurrent identical safe-method requests are collapsed into a single in-flight effect.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dedupKey` | `(req: HttpRequest) => string` | `undefined` | Custom key function that computes a dedup key from an HttpRequest. Overrides the default cache key computation. Return empty string to bypass dedup for a specific request. |

### CacheConfig

Configuration for the response cache layer. Controls how responses are stored and retrieved from the in-memory LRU cache.

| Field | Type | Default | Valid Range | Description |
|-------|------|---------|-------------|-------------|
| `ttlSeconds` | `number` | `60` | `[1, 86400]` | Time-to-live in seconds for cached entries. Values outside the range are clamped. |
| `maxEntries` | `number` | `1024` | `>= 1` | Maximum number of cached entries before LRU eviction. Values less than 1 are clamped to 1. |
| `staleWhileRevalidate` | `boolean` | `false` | — | When `true`, serves stale cache entries immediately while revalidating in the background. |
| `cachePolicy` | `(req: HttpRequest, res: HttpWireResponse) => CachePolicyResult` | `undefined` | — | Custom cache policy function that determines cacheability and optional TTL override per request/response pair. |
| `cacheRelevantHeaders` | `string[]` | `undefined` | — | Additional HTTP headers to include in cache key computation beyond the defaults (`accept`, `authorization`, `content-type`). |

### PriorityConfig

Configuration for the priority scheduler layer. Orders outgoing requests by priority level and limits concurrency.

| Field | Type | Default | Valid Range | Description |
|-------|------|---------|-------------|-------------|
| `concurrency` | `number` | `32` | `>= 1` | Maximum concurrent requests dispatched by the priority scheduler. Values less than 1 are clamped to 1. |
| `queueTimeoutMs` | `number` | `undefined` (no timeout) | `>= 1` | Queue timeout in milliseconds. Requests waiting longer than this value are rejected with a `PoolTimeout` error. |

## API Reference

All public exports from `src/http/lifecycle/index.ts`:

### Types

| Export | Description |
|--------|-------------|
| [`LifecycleClientConfig`](#lifecycleclientconfig) | Configuration for creating a lifecycle client with optional layer settings. |
| [`LifecycleClient`](#lifecycleclientconfig) | Callable HTTP client interface with `.with()`, `.stats()`, `.cancelAll()`, and `.cache` methods. |
| [`LifecycleStats`](#lifecycleclientconfig) | Frozen snapshot of all lifecycle statistics including wire-level stats. |
| [`LifecycleEvent`](#observability) | Event object emitted to the `onEvent` observer during request processing. |
| [`LifecycleEventType`](#observability) | Union of lifecycle event type strings emitted during request processing. |
| [`LifecycleRequestOptions`](#lifecycleclientconfig) | Per-request options for priority, dedup key override, and layer bypass. |
| [`DedupConfig`](#dedupconfig) | Configuration for the deduplication layer. |
| [`CacheConfig`](#cacheconfig) | Configuration for the response cache layer (TTL, max entries, SWR, policy). |
| [`CachePolicyResult`](#cacheconfig) | Result of a custom cache policy evaluation (cacheable flag and optional TTL). |
| [`PriorityConfig`](#priorityconfig) | Configuration for the priority scheduler layer (concurrency, queue timeout). |
| [`CacheKeyComponents`](#cache-key) | Parsed components of a deterministic cache key (method, URL, headers, body). |
| [`LogEvent`](#middleware) | Event object passed to the `withLogging` middleware logger callback. |
| [`LRUCacheConfig`](#api-reference) | Configuration for the standalone LRU cache (maxEntries, onEvict callback). |
| [`PriorityQueueEntry`](#api-reference) | Entry stored in the priority queue with priority, arrivalOrder, and value. |

### Functions

| Export | Description |
|--------|-------------|
| [`makeLifecycleClient`](#quick-start) | Creates a lifecycle-aware HTTP client composing dedup, cache, and priority layers. |
| [`computeCacheKey`](#cache-key) | Computes a deterministic cache key string from an HTTP request. |
| [`parseCacheKey`](#cache-key) | Parses a cache key string back into its component parts (method, URL, headers, body). |
| [`withAuth`](#middleware) | Creates middleware that injects a Bearer token via an async token provider. |
| [`withLogging`](#middleware) | Creates middleware that logs request, response, and error events via a callback. |
| [`withResponseTransform`](#middleware) | Creates middleware that transforms HTTP responses after retrieval. |
| [`withDedup`](#dedupconfig) | Creates dedup middleware that collapses identical in-flight requests into one call. |
| [`withCache`](#cacheconfig) | Creates cache middleware with LRU eviction, TTL, and stale-while-revalidate support. |
| [`withPriority`](#priorityconfig) | Creates priority scheduler middleware that reorders queued requests by priority. |
| [`clampPriority`](#api-reference) | Clamps a priority value to the valid integer range [0, 9], defaulting to 5. |

### Classes

| Export | Description |
|--------|-------------|
| [`LRUCache`](#api-reference) | Generic LRU cache with per-entry TTL, O(1) get/set, and eviction callback support. |
| [`PriorityQueue`](#api-reference) | Generic binary min-heap priority queue with lazy cancellation and FIFO tiebreak. |
| [`LifecycleStatsTracker`](#observability) | Tracks lifecycle statistics and emits events for the HTTP Lifecycle Client. |

### Constants

| Export | Description |
|--------|-------------|
| [`SEPARATOR`](#cache-key) | Null character (`\u0000`) used as separator between cache key components. |
| [`DEFAULT_CACHE_RELEVANT_HEADERS`](#cache-key) | Default headers included in cache key: `["accept", "authorization", "content-type"]`. |
