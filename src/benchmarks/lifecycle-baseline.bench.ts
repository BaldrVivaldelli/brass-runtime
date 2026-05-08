/**
 * Benchmark: Lifecycle Client baseline — zero-cost validation.
 *
 * Measures the per-request latency of a Lifecycle_Client with no layers enabled
 * (no dedup, cache, or priority) against a plain Wire_Client (makeHttp), both
 * using the same in-process mock HTTP handler with zero network I/O.
 *
 * This validates the "zero-cost when disabled" design claim: when no layers are
 * configured, the lifecycle client should add negligible overhead compared to
 * the raw wire client.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { BenchmarkDef, BenchmarkResult } from "./runner";
import { makeHttp } from "../http/client";
import { makeLifecycleClient } from "../http/lifecycle/lifecycleClient";
import { Runtime } from "../core/runtime/runtime";

// ---------------------------------------------------------------------------
// Mock HTTP handler — deterministic 200 response, zero delay, no network I/O
// ---------------------------------------------------------------------------

const MOCK_BODY = JSON.stringify({ ok: true, ts: 0, pad: "x".repeat(40) }); // ~64 bytes

/**
 * In-process mock fetch that returns a deterministic Response without network I/O.
 * This is installed as the global `fetch` so both makeHttp and makeLifecycleClient
 * use it transparently.
 *
 * The resulting HttpWireResponse after processing by makeHttp will be:
 * { status: 200, statusText: "OK", headers: { "content-type": "application/json" },
 *   bodyText: MOCK_BODY, ms: 0 }
 */
const mockFetch: typeof globalThis.fetch = async (_input, _init?) => {
  return new Response(MOCK_BODY, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
};

// Install mock fetch globally
const originalFetch = globalThis.fetch;
globalThis.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

/** Shared runtime — no hooks, minimal overhead. */
const rt = Runtime.make({});

/** Plain wire client via makeHttp. */
const wireClient = makeHttp({ baseUrl: "https://mock.local" });

/** Lifecycle client with NO layers enabled (zero-cost path). */
const lifecycleClient = makeLifecycleClient({ baseUrl: "https://mock.local" });

// ---------------------------------------------------------------------------
// Warning threshold logic (Requirement 3.7)
// ---------------------------------------------------------------------------

/**
 * Compares lifecycle p99 vs wire p99 and annotates the result if the lifecycle
 * client exceeds the wire client by more than 5%.
 *
 * If lifecycle.p99 > wire.p99 * 1.05, the returned result has `warning: true`
 * and the operation name is prefixed with "[WARN] ".
 */
export function applyWarningThreshold(
  lifecycleResult: BenchmarkResult,
  wireResult: BenchmarkResult,
): BenchmarkResult & { warning?: boolean } {
  const threshold = wireResult.percentiles.p99 * 1.05;
  if (lifecycleResult.percentiles.p99 > threshold) {
    return {
      ...lifecycleResult,
      operation: `[WARN] ${lifecycleResult.operation}`,
      warning: true,
    };
  }
  return lifecycleResult;
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const benchmarks: BenchmarkDef[] = [
  {
    name: "lifecycle client (no layers) — GET request",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      await rt.toPromise(lifecycleClient({ method: "GET", url: "/bench" }));
    },
  },
  {
    name: "wire client (makeHttp) — GET request",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      await rt.toPromise(wireClient({ method: "GET", url: "/bench" }));
    },
  },
];
