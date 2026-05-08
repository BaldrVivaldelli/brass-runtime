/**
 * Benchmark: Priority scheduler layer overhead.
 *
 * Measures the cost of the priority scheduling layer in isolation
 * (dedup and cache disabled). Two scenarios:
 *
 * 1. Uncontended — concurrency=32, single request in flight at a time.
 *    Captures heap-insertion and extraction cost when no queuing occurs.
 *
 * 2. Contended — concurrency=1, 100 concurrent requests with priorities
 *    uniformly distributed 0-9. Captures ordering cost under load.
 *
 * A baseline measurement (no layers) is included to compute layer overhead.
 */

import type { BenchmarkDef } from "./runner";
import { makeLifecycleClient } from "../http/lifecycle/lifecycleClient";
import type { HttpWireResponse } from "../http/client";
import { Runtime } from "../core/runtime/runtime";

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const MOCK_RESPONSE: HttpWireResponse = {
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  bodyText: JSON.stringify({ ok: true, ts: 0, pad: "x".repeat(40) }),
  ms: 0,
};

/**
 * Mock fetch that returns a deterministic 200 response with zero network I/O.
 */
const mockFetch: typeof globalThis.fetch = () =>
  Promise.resolve(
    new Response(MOCK_RESPONSE.bodyText, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    })
  );

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const benchmarks: BenchmarkDef[] = [
  // --- Baseline: no layers ---
  {
    name: "Priority baseline (no layers)",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = makeLifecycleClient({
          baseUrl: "https://bench.local",
        });
        await run<HttpWireResponse>(
          client({ method: "GET", url: "/test" })
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },

  // --- Uncontended: concurrency=32, single request in flight ---
  {
    name: "Priority: uncontended (concurrency=32, 1 in flight)",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = makeLifecycleClient({
          baseUrl: "https://bench.local",
          priority: { concurrency: 32 },
          dedup: false,
          cache: false,
        });
        await run<HttpWireResponse>(
          client({ method: "GET", url: "/test", priority: 3 } as any)
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },

  // --- Contended: concurrency=1, 100 concurrent requests ---
  {
    name: "Priority: contended (concurrency=1, 100 concurrent, priorities 0-9)",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = makeLifecycleClient({
          baseUrl: "https://bench.local",
          priority: { concurrency: 1 },
          dedup: false,
          cache: false,
        });

        // Fire 100 concurrent requests with priorities uniformly distributed 0-9
        const requests = Array.from({ length: 100 }, (_, i) =>
          run<HttpWireResponse>(
            client({ method: "GET", url: `/test/${i}`, priority: i % 10 } as any)
          )
        );
        await Promise.all(requests);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];
