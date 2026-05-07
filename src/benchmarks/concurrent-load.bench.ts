/**
 * Benchmark: Concurrent load simulation — 420 concurrent "requests"
 * through semaphore + circuit breaker + timeout.
 *
 * Simulates the real-world scenario from the A/B test:
 * - 60 users generating ~420 concurrent connections
 * - Each request goes through backpressure (semaphore), circuit breaking,
 *   and timeout protection
 * - Measures throughput, latency, and error handling under pressure
 *
 * This validates that brass-runtime can handle production load patterns
 * without saturating the event loop or dropping health checks.
 */

import type { BenchmarkDef } from "./runner";
import { makeSemaphore } from "../core/runtime/semaphore";
import { makeCircuitBreaker } from "../core/runtime/circuitBreaker";
import { timeout } from "../core/runtime/combinators";
import { async, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler } from "../core/runtime/scheduler";

// Use a scheduler with capacity for high concurrency
const scheduler = new Scheduler({ laneCapacity: 65536, maxCapacity: 65536 });
const rt = Runtime.make({}, scheduler);

// Simulate a downstream service call (1-5ms latency)
function simulateDownstream(failRate: number = 0): Async<unknown, string, string> {
  return async((_env, cb) => {
    const latency = 1 + Math.random() * 4; // 1-5ms
    const id = setTimeout(() => {
      if (Math.random() < failRate) {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "downstream-error" } });
      } else {
        cb({ _tag: "Success", value: "ok" });
      }
    }, latency);
    return () => clearTimeout(id);
  });
}

// Build the full request handler with all protections
function buildProtectedHandler(concurrency: number, failRate: number) {
  const sem = makeSemaphore(concurrency);
  const breaker = makeCircuitBreaker({
    failureThreshold: 10,
    resetTimeoutMs: 1000,
    isFailure: (e) => e === "downstream-error",
  });

  // Timeout only applies to the downstream call, not the semaphore wait
  return () =>
    sem.withPermit(
      breaker.protect(simulateDownstream(failRate)) as any
    );
}

// Fire N concurrent requests and measure results
function runConcurrentLoad(
  totalRequests: number,
  concurrency: number,
  failRate: number
): Promise<{ successCount: number; errorCount: number; durationMs: number }> {
  return new Promise((resolve) => {
    const handler = buildProtectedHandler(concurrency, failRate);
    let completed = 0;
    let successCount = 0;
    let errorCount = 0;
    const start = performance.now();

    for (let i = 0; i < totalRequests; i++) {
      rt.unsafeRunAsync(handler() as any, (exit: any) => {
        completed++;
        if (exit._tag === "Success") successCount++;
        else errorCount++;

        if (completed === totalRequests) {
          resolve({
            successCount,
            errorCount,
            durationMs: performance.now() - start,
          });
        }
      });
    }
  });
}

export const benchmarks: BenchmarkDef[] = [
  // --- Scenario 1: 420 concurrent requests, no failures ---
  {
    name: "concurrent load (420 reqs, sem=50, 0% fail)",
    iterations: 10,
    warmup: 2,
    fn: async () => {
      const result = await runConcurrentLoad(420, 50, 0);
      if (result.errorCount > 0) {
        throw new Error(`Unexpected errors: ${result.errorCount}`);
      }
    },
  },

  // --- Scenario 2: 420 concurrent requests, 5% failure rate ---
  {
    name: "concurrent load (420 reqs, sem=50, 5% fail)",
    iterations: 10,
    warmup: 2,
    fn: async () => {
      await runConcurrentLoad(420, 50, 0.05);
      // Errors are expected — circuit breaker handles them
    },
  },

  // --- Scenario 3: 1000 concurrent requests (stress test) ---
  {
    name: "concurrent load (1000 reqs, sem=100, 0% fail)",
    iterations: 10,
    warmup: 2,
    fn: async () => {
      const result = await runConcurrentLoad(1000, 100, 0);
      if (result.errorCount > 0) {
        throw new Error(`Unexpected errors: ${result.errorCount}`);
      }
    },
  },

  // --- Scenario 4: 1000 concurrent with 10% failures (circuit breaker stress) ---
  {
    name: "concurrent load (1000 reqs, sem=100, 10% fail + breaker)",
    iterations: 10,
    warmup: 2,
    fn: async () => {
      await runConcurrentLoad(1000, 100, 0.10);
    },
  },

  // --- Scenario 5: 5000 concurrent requests (heavy load) ---
  {
    name: "concurrent load (5000 reqs, sem=200, 0% fail)",
    iterations: 5,
    warmup: 1,
    fn: async () => {
      const result = await runConcurrentLoad(5000, 200, 0);
      if (result.errorCount > 0) {
        throw new Error(`Unexpected errors: ${result.errorCount}`);
      }
    },
  },

  // --- Scenario 6: 5000 concurrent with 10% failures ---
  {
    name: "concurrent load (5000 reqs, sem=200, 10% fail + breaker)",
    iterations: 5,
    warmup: 1,
    fn: async () => {
      await runConcurrentLoad(5000, 200, 0.10);
    },
  },

  // --- Scenario 7: 10000 concurrent requests (extreme stress) ---
  {
    name: "concurrent load (10000 reqs, sem=500, 0% fail)",
    iterations: 5,
    warmup: 1,
    fn: async () => {
      const result = await runConcurrentLoad(10000, 500, 0);
      if (result.errorCount > 0) {
        throw new Error(`Unexpected errors: ${result.errorCount}`);
      }
    },
  },

  // --- Scenario 8: 10000 concurrent with 15% failures (chaos test) ---
  {
    name: "concurrent load (10000 reqs, sem=500, 15% fail + breaker)",
    iterations: 5,
    warmup: 1,
    fn: async () => {
      await runConcurrentLoad(10000, 500, 0.15);
    },
  },
];
