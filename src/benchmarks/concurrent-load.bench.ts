/**
 * Benchmark: Concurrent load simulation.
 *
 * This suite is intentionally a diagnostic ladder. The full scenario exercises
 * runtime + semaphore + circuit breaker + timers, while the smaller scenarios
 * isolate where latency grows when the request count scales.
 */

import type { BenchmarkDef } from "./runner";
import { makeSemaphore, type Semaphore } from "../core/runtime/semaphore";
import { makeCircuitBreaker, type CircuitBreaker } from "../core/runtime/circuitBreaker";
import { async } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler } from "../core/runtime/scheduler";

const DEFAULT_LATENCY_MS = 3;
const DEFAULT_LANE_CAPACITY = 65_536;

type LoadMode = "runtime" | "semaphore" | "breaker" | "full";
type LaneStrategy = "fixed" | "inferred";

type LoadDetails = Record<string, unknown> & {
  units: number;
  unit: "req";
  requests: number;
  concurrency: number;
  successCount: number;
  errorCount: number;
  durationMs: number;
  reqPerSec: number;
};

type RuntimeLoadConfig = {
  readonly requests: number;
  readonly concurrency: number;
  readonly failRate: number;
  readonly mode: LoadMode;
  readonly laneStrategy?: LaneStrategy;
};

// Simulate a downstream service call with stable latency for lower-noise diffs.
function simulateDownstream(failRate: number = 0, latencyMs: number = DEFAULT_LATENCY_MS): Async<unknown, string, string> {
  return async((_env, cb) => {
    const id = setTimeout(() => {
      if (Math.random() < failRate) {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "downstream-error" } });
      } else {
        cb({ _tag: "Success", value: "ok" });
      }
    }, latencyMs);
    return () => clearTimeout(id);
  });
}

function simulateDownstreamPromise(failRate: number = 0, latencyMs: number = DEFAULT_LATENCY_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < failRate) reject("downstream-error");
      else resolve("ok");
    }, latencyMs);
  });
}

function makeLoadRuntime(strategy: LaneStrategy, requests: number): { rt: Runtime<{}>; scheduler: Scheduler } {
  const capacity = Math.max(DEFAULT_LANE_CAPACITY, requests * 4);
  const scheduler = new Scheduler({
    laneCapacity: capacity,
    maxCapacity: capacity,
  });
  const base = Runtime.makeWithEngine({}, "ts", {
    scheduler,
    inferLane: strategy === "inferred",
  });
  return {
    scheduler,
    rt: strategy === "fixed" ? base.withLane("bench/concurrent-load") : base,
  };
}

function makeBreaker(): CircuitBreaker {
  return makeCircuitBreaker({
    failureThreshold: 10,
    resetTimeoutMs: 1000,
    isFailure: (e) => e === "downstream-error",
  });
}

function buildRuntimeHandler(config: RuntimeLoadConfig): {
  handler: () => Async<unknown, unknown, string>;
  sem?: Semaphore;
  breaker?: CircuitBreaker;
} {
  const sem = config.mode === "semaphore" || config.mode === "full"
    ? makeSemaphore(config.concurrency)
    : undefined;
  const breaker = config.mode === "breaker" || config.mode === "full"
    ? makeBreaker()
    : undefined;

  const downstream = () => simulateDownstream(config.failRate);

  switch (config.mode) {
    case "runtime":
      return { handler: downstream };
    case "semaphore":
      return { sem, handler: () => sem!.withPermit(downstream()) };
    case "breaker":
      return { breaker, handler: () => breaker!.protect(downstream()) as any };
    case "full":
      return {
        sem,
        breaker,
        handler: () => sem!.withPermit(breaker!.protect(downstream()) as any),
      };
  }
}

function runRuntimeLoad(config: RuntimeLoadConfig): Promise<LoadDetails> {
  return new Promise((resolve) => {
    const laneStrategy = config.laneStrategy ?? "fixed";
    const { rt, scheduler } = makeLoadRuntime(laneStrategy, config.requests);
    const { handler, sem, breaker } = buildRuntimeHandler(config);
    let completed = 0;
    let successCount = 0;
    let errorCount = 0;
    const start = performance.now();

    for (let i = 0; i < config.requests; i++) {
      rt.unsafeRunAsync(handler() as any, (exit: any) => {
        completed++;
        if (exit._tag === "Success") successCount++;
        else errorCount++;

        if (completed === config.requests) {
          const durationMs = performance.now() - start;
          const schedulerStats = scheduler.stats().data;
          const breakerStats = breaker?.stats();
          resolve({
            units: config.requests,
            unit: "req",
            requests: config.requests,
            concurrency: config.concurrency,
            successCount,
            errorCount,
            durationMs,
            reqPerSec: config.requests / (durationMs / 1000),
            mode: config.mode,
            laneStrategy,
            schedulerExecuted: schedulerStats.executedTasks ?? 0,
            schedulerFlushes: schedulerStats.completedFlushes ?? 0,
            schedulerLen: schedulerStats.len,
            semWaiting: sem?.waiting() ?? 0,
            semAvailable: sem?.available() ?? config.concurrency,
            breakerState: breaker?.state() ?? "none",
            breakerRejected: breakerStats?.totalRejected ?? 0,
          });
        }
      });
    }
  });
}

function runNativeTimerPool(requests: number, concurrency: number, failRate: number): Promise<LoadDetails> {
  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let completed = 0;
    let successCount = 0;
    let errorCount = 0;
    const start = performance.now();

    const launch = (): void => {
      while (active < concurrency && next < requests) {
        next++;
        active++;
        simulateDownstreamPromise(failRate).then(
          () => { successCount++; },
          () => { errorCount++; },
        ).finally(() => {
          active--;
          completed++;
          if (completed === requests) {
            const durationMs = performance.now() - start;
            resolve({
              units: requests,
              unit: "req",
              requests,
              concurrency,
              successCount,
              errorCount,
              durationMs,
              reqPerSec: requests / (durationMs / 1000),
              mode: "native-timer-pool",
              laneStrategy: "none",
            });
            return;
          }
          launch();
        });
      }
    };

    launch();
  });
}

function expectNoUnexpectedErrors(result: LoadDetails): void {
  if (result.errorCount > 0) {
    throw new Error(`Unexpected errors: ${result.errorCount}`);
  }
}

function runtimeBenchmark(
  name: string,
  config: RuntimeLoadConfig,
  iterations: number,
  warmup: number,
  expectClean = config.failRate === 0,
): BenchmarkDef {
  return {
    name,
    iterations,
    warmup,
    unitsPerRun: config.requests,
    unit: "req",
    fn: async () => {
      const result = await runRuntimeLoad(config);
      if (expectClean) expectNoUnexpectedErrors(result);
      return result;
    },
  };
}

function nativeBenchmark(
  name: string,
  requests: number,
  concurrency: number,
  failRate: number,
  iterations: number,
  warmup: number,
): BenchmarkDef {
  return {
    name,
    iterations,
    warmup,
    unitsPerRun: requests,
    unit: "req",
    fn: () => runNativeTimerPool(requests, concurrency, failRate),
  };
}

export const benchmarks: BenchmarkDef[] = [
  nativeBenchmark("concurrent diag native timer pool (1000 reqs, pool=100)", 1000, 100, 0, 8, 2),
  runtimeBenchmark("concurrent diag runtime only fixed lane (1000 reqs)", {
    requests: 1000,
    concurrency: 1000,
    failRate: 0,
    mode: "runtime",
    laneStrategy: "fixed",
  }, 8, 2),
  runtimeBenchmark("concurrent diag runtime only inferred lane (1000 reqs)", {
    requests: 1000,
    concurrency: 1000,
    failRate: 0,
    mode: "runtime",
    laneStrategy: "inferred",
  }, 8, 2),
  runtimeBenchmark("concurrent diag semaphore only (1000 reqs, sem=100)", {
    requests: 1000,
    concurrency: 100,
    failRate: 0,
    mode: "semaphore",
  }, 8, 2),
  runtimeBenchmark("concurrent diag breaker only (1000 reqs, 0% fail)", {
    requests: 1000,
    concurrency: 1000,
    failRate: 0,
    mode: "breaker",
  }, 8, 2),
  runtimeBenchmark("concurrent diag full stack (1000 reqs, sem=100, 0% fail)", {
    requests: 1000,
    concurrency: 100,
    failRate: 0,
    mode: "full",
  }, 8, 2),

  runtimeBenchmark("concurrent load full stack (420 reqs, sem=50, 0% fail)", {
    requests: 420,
    concurrency: 50,
    failRate: 0,
    mode: "full",
  }, 10, 2),
  runtimeBenchmark("concurrent load full stack (420 reqs, sem=50, 5% fail)", {
    requests: 420,
    concurrency: 50,
    failRate: 0.05,
    mode: "full",
  }, 10, 2, false),
  runtimeBenchmark("concurrent load full stack (1000 reqs, sem=100, 0% fail)", {
    requests: 1000,
    concurrency: 100,
    failRate: 0,
    mode: "full",
  }, 10, 2),
  runtimeBenchmark("concurrent load full stack (1000 reqs, sem=100, 10% fail + breaker)", {
    requests: 1000,
    concurrency: 100,
    failRate: 0.10,
    mode: "full",
  }, 10, 2, false),
  runtimeBenchmark("concurrent load full stack (5000 reqs, sem=200, 0% fail)", {
    requests: 5000,
    concurrency: 200,
    failRate: 0,
    mode: "full",
  }, 5, 1),
  runtimeBenchmark("concurrent load full stack (5000 reqs, sem=200, 10% fail + breaker)", {
    requests: 5000,
    concurrency: 200,
    failRate: 0.10,
    mode: "full",
  }, 5, 1, false),
  runtimeBenchmark("concurrent load full stack (10000 reqs, sem=500, 0% fail)", {
    requests: 10000,
    concurrency: 500,
    failRate: 0,
    mode: "full",
  }, 5, 1),
  runtimeBenchmark("concurrent load full stack (10000 reqs, sem=500, 15% fail + breaker)", {
    requests: 10000,
    concurrency: 500,
    failRate: 0.15,
    mode: "full",
  }, 5, 1, false),
];
