/**
 * Benchmark: Stream pipeline — 10k elements through map+filter, target < 50ms total.
 *
 * Validates Requirement 11.4: latency of processing a stream of 10,000
 * elements through a pipeline with map and filter, with a target of
 * less than 50ms total.
 *
 * Three scenarios are measured:
 *
 * 1. **map-only pipeline** — 10k elements through `mapP(x => x * 2)`,
 *    measures pure transformation overhead.
 *
 * 2. **filter-only pipeline** — 10k elements through
 *    `filterP(x => x % 2 === 0)`, measures filter overhead (keeps ~50%
 *    of elements).
 *
 * 3. **map+filter composed pipeline** — 10k elements through
 *    `andThen(mapP(x => x * 2), filterP(x => x % 3 === 0))`, measures
 *    composed pipeline overhead (the main target scenario).
 */

import type { BenchmarkDef } from "./runner";
import { fromArray, collectStream } from "../core/stream/stream";
import { via, mapP, filterP, andThen } from "../core/stream/pipeline";
import { Runtime } from "../core/runtime/runtime";

const ELEMENT_COUNT = 10_000;

/** Pre-created array of 10,000 numbers (0..9999). */
const elements: number[] = Array.from({ length: ELEMENT_COUNT }, (_, i) => i);

/** Shared runtime instance — no hooks, minimal overhead. */
const rt = Runtime.make({});

export const benchmarks: BenchmarkDef[] = [
  // --- Scenario 1: map-only pipeline ---
  {
    name: `stream map pipeline (${ELEMENT_COUNT.toLocaleString()} elements)`,
    iterations: 50,
    warmup: 10,
    fn: () => {
      const stream = fromArray(elements);
      const pipeline = mapP<number, number>((x) => x * 2);
      const piped = via(stream, pipeline);
      const eff = collectStream(piped);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },

  // --- Scenario 2: filter-only pipeline ---
  {
    name: `stream filter pipeline (${ELEMENT_COUNT.toLocaleString()} elements)`,
    iterations: 50,
    warmup: 10,
    fn: () => {
      const stream = fromArray(elements);
      const pipeline = filterP<number>((x) => x % 2 === 0);
      const piped = via(stream, pipeline);
      const eff = collectStream(piped);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },

  // --- Scenario 3: map+filter composed pipeline ---
  {
    name: `stream map+filter pipeline (${ELEMENT_COUNT.toLocaleString()} elements)`,
    iterations: 50,
    warmup: 10,
    fn: () => {
      const stream = fromArray(elements);
      const pipeline = andThen(
        mapP<number, number>((x) => x * 2),
        filterP<number>((x) => x % 3 === 0)
      );
      const piped = via(stream, pipeline);
      const eff = collectStream(piped);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },
];
