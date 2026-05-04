/**
 * Benchmark: Scheduler throughput — 100k tasks, target < 50ms total.
 *
 * Validates Requirement 11.2: throughput of the Scheduler processing
 * 100,000 tasks, with a target of less than 50ms total.
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
import { Scheduler } from "../core/runtime/scheduler";

const TASK_COUNT = 100_000;
const CONCURRENCY = 100; // number of parallel chains for the fan-out variant
const TASKS_PER_CHAIN = TASK_COUNT / CONCURRENCY; // 1000 each

export const benchmarks: BenchmarkDef[] = [
  // --- Scenario 1: sequential re-enqueue (single chain) ---
  {
    name: `scheduler sequential (${TASK_COUNT.toLocaleString()} tasks)`,
    iterations: 50,
    warmup: 10,
    fn: () => {
      return new Promise<void>((resolve) => {
        const scheduler = new Scheduler();
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
    },
  },

  // --- Scenario 2: concurrent fan-out (multiple chains) ---
  {
    name: `scheduler fan-out (${CONCURRENCY} chains × ${TASKS_PER_CHAIN.toLocaleString()} tasks)`,
    iterations: 50,
    warmup: 10,
    fn: () => {
      return new Promise<void>((resolve) => {
        const scheduler = new Scheduler();
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
    },
  },
];
