/**
 * Benchmark: Dedup layer overhead measurement.
 *
 * Measures the cost of the deduplication layer in isolation by wrapping
 * a no-op inner handler with `withDedup`. Compares against a baseline
 * (same no-op handler without any layer) to compute layer overhead.
 *
 * Scenarios:
 * - Unique requests: sequential requests with distinct keys (dedup miss path)
 * - Concurrent identical: 10 concurrent requests sharing the same dedup key (dedup hit path)
 */

import type { BenchmarkDef } from "./runner";
import type { HttpClientFn, HttpWireResponse } from "../http/client";
import type { Async } from "../core/types/asyncEffect";
import { asyncSucceed } from "../core/types/asyncEffect";
import type { HttpError } from "../http/client";
import { withDedup } from "../http/lifecycle/dedup";

// ---------------------------------------------------------------------------
// Mock HTTP handler — deterministic 200 response, zero network I/O
// ---------------------------------------------------------------------------

const MOCK_RESPONSE: HttpWireResponse = {
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  bodyText: JSON.stringify({ ok: true, ts: 0, pad: "x".repeat(40) }),
  ms: 0,
};

/**
 * Synchronous mock handler for baseline and unique-request benchmarks.
 */
const mockHandler: HttpClientFn = (_req) => asyncSucceed(MOCK_RESPONSE);

/**
 * Async mock handler that resolves via microtask. Required for the concurrent
 * dedup-hit benchmark so that multiple requests can be in-flight simultaneously
 * and actually hit the dedup sharing path.
 */
const asyncMockHandler: HttpClientFn = (_req): Async<unknown, HttpError, HttpWireResponse> => ({
  _tag: "Async",
  register: (_env, cb) => {
    queueMicrotask(() => cb({ _tag: "Success", value: MOCK_RESPONSE }));
  },
});

// ---------------------------------------------------------------------------
// Dedup-enabled handlers (only dedup layer, no cache or priority)
// ---------------------------------------------------------------------------

const dedupMiddleware = withDedup({
  dedupKey: (req) => `${req.method}:${req.url}`,
});

/** Dedup wrapping synchronous mock — for unique requests (sequential). */
const dedupHandler: HttpClientFn = dedupMiddleware(mockHandler);

/** Dedup wrapping async mock — for concurrent identical requests. */
const dedupConcurrentHandler: HttpClientFn = dedupMiddleware(asyncMockHandler);

// ---------------------------------------------------------------------------
// Helper: run an Async effect to completion
// ---------------------------------------------------------------------------

function runEffect(effect: ReturnType<HttpClientFn>): Promise<HttpWireResponse> {
  return new Promise((resolve, reject) => {
    if (effect._tag === "Succeed") {
      resolve(effect.value);
      return;
    }
    if (effect._tag === "Fail") {
      reject(effect.error);
      return;
    }
    if (effect._tag === "Async") {
      effect.register({}, (exit) => {
        if (exit._tag === "Success") {
          resolve(exit.value);
        } else {
          reject(exit.cause);
        }
      });
      return;
    }
    // FlatMap/Fold/Sync — shouldn't occur with our simple mock
    reject(new Error(`Unexpected effect tag: ${(effect as any)._tag}`));
  });
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

export const benchmarks: BenchmarkDef[] = [
  // Baseline: no-op handler without any layer (reference point)
  {
    name: "Dedup baseline (no layer)",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      await runEffect(mockHandler({ method: "GET", url: "/baseline" }));
    },
  },

  // Unique requests: each request has a distinct URL so every request is a dedup miss
  {
    name: "Dedup: unique requests",
    iterations: 1000,
    warmup: 50,
    fn: (() => {
      let counter = 0;
      return async () => {
        await runEffect(
          dedupHandler({ method: "GET", url: `/req-${counter++}` })
        );
      };
    })(),
  },

  // Concurrent identical: 10 concurrent requests with the same dedup key
  {
    name: "Dedup: concurrent identical (10)",
    iterations: 1000,
    warmup: 50,
    fn: async () => {
      const promises: Promise<HttpWireResponse>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          runEffect(dedupConcurrentHandler({ method: "GET", url: "/same" }))
        );
      }
      await Promise.all(promises);
    },
  },
];
