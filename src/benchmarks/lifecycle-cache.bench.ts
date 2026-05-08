/**
 * Cache layer overhead benchmark for the HTTP Lifecycle Client.
 *
 * Measures per-request latency with only the cache layer enabled (dedup and
 * priority disabled) using an in-process mock HTTP handler. Scenarios:
 *   - Cache miss: unique URL per iteration (key-computation + storage cost)
 *   - Cache hit: same URL every iteration (lookup + retrieval cost)
 *   - Cache eviction: maxEntries=100 with 200 unique keys (LRU eviction throughput)
 *   - Baseline: same mock, no layers (reference for overhead computation)
 */

import type { BenchmarkDef } from "./runner";
import type { HttpClientFn, HttpWireResponse } from "../http/client";
import { asyncSucceed } from "../core/types/asyncEffect";
import { makeLifecycleClient } from "../http/lifecycle/lifecycleClient";
import { Runtime } from "../core/runtime/runtime";

// ---------------------------------------------------------------------------
// Mock HTTP handler
// ---------------------------------------------------------------------------

const MOCK_RESPONSE: HttpWireResponse = {
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  bodyText: JSON.stringify({ ok: true, ts: 0, pad: "x".repeat(40) }), // ~64 bytes
  ms: 0,
};

/**
 * No-op mock fetch that returns a deterministic 200 response.
 * Installed on globalThis.fetch to intercept all requests without network I/O.
 */
const mockFetch = () =>
  Promise.resolve(
    new Response(MOCK_RESPONSE.bodyText, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    })
  );

// ---------------------------------------------------------------------------
// Runtime helper
// ---------------------------------------------------------------------------

const rt = Runtime.make({});
const run = <A>(eff: any): Promise<A> => rt.toPromise(eff);

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

const ITERATIONS = 1000;
const WARMUP = 50;

export const benchmarks: BenchmarkDef[] = [
  // -------------------------------------------------------------------------
  // Baseline: no layers enabled (reference measurement)
  // -------------------------------------------------------------------------
  {
    name: "Cache benchmark baseline (no layers)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
      });
      globalThis.fetch = originalFetch;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch as any;
        try {
          await run<HttpWireResponse>(
            client({ method: "GET", url: "/baseline" })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },

  // -------------------------------------------------------------------------
  // Cache miss: unique URL per iteration
  // -------------------------------------------------------------------------
  {
    name: "Cache: miss (unique key per request)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
        cache: { ttlSeconds: 60, maxEntries: 1024 },
        dedup: false,
        priority: false,
      });
      globalThis.fetch = originalFetch;

      let counter = 0;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch as any;
        try {
          await run<HttpWireResponse>(
            client({ method: "GET", url: `/miss/${counter++}` })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },

  // -------------------------------------------------------------------------
  // Cache hit: same URL every iteration (cache pre-populated during warmup)
  // -------------------------------------------------------------------------
  {
    name: "Cache: hit (same key, pre-populated)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
        cache: { ttlSeconds: 60, maxEntries: 1024 },
        dedup: false,
        priority: false,
      });
      globalThis.fetch = originalFetch;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch as any;
        try {
          await run<HttpWireResponse>(
            client({ method: "GET", url: "/hit/stable-key" })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },

  // -------------------------------------------------------------------------
  // Cache eviction: maxEntries=100, 200 unique keys causing 100+ LRU evictions
  // -------------------------------------------------------------------------
  {
    name: "Cache: eviction (maxEntries=100, 200 unique keys)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
        cache: { ttlSeconds: 60, maxEntries: 100 },
        dedup: false,
        priority: false,
      });
      globalThis.fetch = originalFetch;

      let counter = 0;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch as any;
        try {
          // Cycle through 200 unique keys to force evictions
          const key = counter % 200;
          counter++;
          await run<HttpWireResponse>(
            client({ method: "GET", url: `/evict/${key}` })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },
];
