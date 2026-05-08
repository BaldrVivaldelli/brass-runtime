/**
 * Benchmark: Combined layers — all three layers enabled simultaneously.
 *
 * Measures per-request latency with dedup, cache, and priority layers all
 * enabled on a single Lifecycle_Client instance. Two scenarios:
 *
 * 1. Unique requests — distinct URL per iteration so each request traverses
 *    all layers (cache miss, no dedup hit, uncontended priority queue).
 *
 * 2. Repeated requests (cache hit) — same URL every iteration. Warmup
 *    populates the cache, then measured iterations hit the cache layer.
 *
 * A baseline measurement (wire client without layers) is included to compute
 * total layer overhead as the p50 difference.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import type { BenchmarkDef } from "./runner";
import type { HttpWireResponse } from "../http/client";
import { makeLifecycleClient } from "../http/lifecycle/lifecycleClient";
import { Runtime } from "../core/runtime/runtime";

// ---------------------------------------------------------------------------
// Mock HTTP handler — deterministic 200 response, zero network I/O
// ---------------------------------------------------------------------------

const MOCK_BODY = JSON.stringify({ ok: true, ts: 0, pad: "x".repeat(40) }); // ~64 bytes

/**
 * In-process mock fetch that returns a deterministic Response without network I/O.
 * Installed on globalThis.fetch so both wire and lifecycle clients use it.
 */
const mockFetch: typeof globalThis.fetch = async (_input, _init?) => {
  return new Response(MOCK_BODY, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
};

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
  // Baseline: wire client without any layers (reference for overhead)
  // -------------------------------------------------------------------------
  {
    name: "Combined baseline (no layers)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
      });
      globalThis.fetch = originalFetch;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch;
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
  // Combined: unique requests — full traversal of all layers
  // Each iteration uses a distinct URL so:
  //   - Cache miss (no prior entry)
  //   - No dedup hit (unique key)
  //   - Uncontended priority (concurrency=32, single request)
  // -------------------------------------------------------------------------
  {
    name: "Combined: unique requests (all layers, cache miss)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
        dedup: {},
        cache: { ttlSeconds: 60, maxEntries: 1024 },
        priority: { concurrency: 32 },
      });
      globalThis.fetch = originalFetch;

      let counter = 0;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch;
        try {
          await run<HttpWireResponse>(
            client({ method: "GET", url: `/combined/unique/${counter++}` })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },

  // -------------------------------------------------------------------------
  // Combined: repeated requests (cache hit path)
  // Same URL every iteration. Warmup populates the cache, then measured
  // iterations are served from cache without reaching the wire client.
  // -------------------------------------------------------------------------
  {
    name: "Combined: repeated requests (cache hit)",
    iterations: ITERATIONS,
    warmup: WARMUP,
    fn: (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      const client = makeLifecycleClient({
        baseUrl: "https://bench.local",
        dedup: {},
        cache: { ttlSeconds: 60, maxEntries: 1024 },
        priority: { concurrency: 32 },
      });
      globalThis.fetch = originalFetch;

      return async () => {
        const prev = globalThis.fetch;
        globalThis.fetch = mockFetch;
        try {
          await run<HttpWireResponse>(
            client({ method: "GET", url: "/combined/repeated/stable-key" })
          );
        } finally {
          globalThis.fetch = prev;
        }
      };
    })(),
  },
];
