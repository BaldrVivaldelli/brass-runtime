/**
 * Benchmark: Scheduler throughput — 1M tasks.
 *
 * Validates Requirement 11.2: throughput of the Scheduler processing
 * 1,000,000 tasks.
 *
 * Two scenarios are measured:
 *
 * 1. **Sequential re-enqueue** — each task schedules the next one upon
 *    completion, mirroring the real fiber execution pattern (one task
 *    per step, each step re-enqueuing the fiber for the next opcode
 *    batch).
 *
 * 2. **Concurrent fan-out** — multiple independent chains run in
 *    parallel, stressing the scheduler's batching and flush budget
 *    with higher queue occupancy.
 */

import type { BenchmarkDef } from "./runner";
import { Scheduler, type SchedulerLaneMode } from "../core/runtime/scheduler";

const TASK_COUNT = 1_000_000;
const CONCURRENCY = 100; // number of parallel chains for the fan-out variant
const TASKS_PER_CHAIN = TASK_COUNT / CONCURRENCY; // 10,000 each
const DEFAULT_FLUSH_BUDGET = 2_048;
const THROUGHPUT_FLUSH_BUDGET = 8_192;

function makeScheduler(laneMode: SchedulerLaneMode, flushBudget: number): Scheduler {
  return new Scheduler({ laneMode, flushBudget });
}

function sequential(flushBudget: number, laneMode: SchedulerLaneMode): Promise<void> {
  return new Promise<void>((resolve) => {
    const scheduler = makeScheduler(laneMode, flushBudget);
    let remaining = TASK_COUNT;

    function step(): void {
      remaining--;
      if (remaining > 0) {
        scheduler.schedule(step, "bench");
      } else {
        resolve();
      }
    }

    scheduler.schedule(step, "bench-start");
  });
}

function fanOut(flushBudget: number, laneMode: SchedulerLaneMode): Promise<void> {
  return new Promise<void>((resolve) => {
    const scheduler = makeScheduler(laneMode, flushBudget);
    let chainsComplete = 0;

    function makeChain(tasksLeft: number): void {
      scheduler.schedule(function chainStep() {
        if (tasksLeft > 1) {
          scheduler.schedule(chainStep, "bench-chain");
          tasksLeft--;
        } else {
          chainsComplete++;
          if (chainsComplete === CONCURRENCY) {
            resolve();
          }
        }
      }, "bench-chain");
    }

    for (let c = 0; c < CONCURRENCY; c++) {
      makeChain(TASKS_PER_CHAIN);
    }
  });
}

export const benchmarks: BenchmarkDef[] = [
  {
    name: `scheduler fair sequential (${TASK_COUNT.toLocaleString()} tasks, flush=${DEFAULT_FLUSH_BUDGET})`,
    iterations: 20,
    warmup: 5,
    fn: () => sequential(DEFAULT_FLUSH_BUDGET, "fair"),
  },
  {
    name: `scheduler single-lane sequential (${TASK_COUNT.toLocaleString()} tasks, flush=${DEFAULT_FLUSH_BUDGET})`,
    iterations: 20,
    warmup: 5,
    fn: () => sequential(DEFAULT_FLUSH_BUDGET, "single"),
  },
  {
    name: `scheduler single-lane sequential (${TASK_COUNT.toLocaleString()} tasks, flush=${THROUGHPUT_FLUSH_BUDGET})`,
    iterations: 20,
    warmup: 5,
    fn: () => sequential(THROUGHPUT_FLUSH_BUDGET, "single"),
  },

  {
    name: `scheduler fair fan-out (${CONCURRENCY} chains x ${TASKS_PER_CHAIN.toLocaleString()} tasks, flush=${DEFAULT_FLUSH_BUDGET})`,
    iterations: 20,
    warmup: 5,
    fn: () => fanOut(DEFAULT_FLUSH_BUDGET, "fair"),
  },
  {
    name: `scheduler single-lane fan-out (${CONCURRENCY} chains x ${TASKS_PER_CHAIN.toLocaleString()} tasks, flush=${THROUGHPUT_FLUSH_BUDGET})`,
    iterations: 20,
    warmup: 5,
    fn: () => fanOut(THROUGHPUT_FLUSH_BUDGET, "single"),
  },
];
