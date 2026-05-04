/**
 * Benchmark: FlatMap chain — 1000 effects chained via asyncFlatMap.
 *
 * Validates Requirement 11.1: latency of executing chains of 1000 FlatMap
 * effects, with a target of less than 1ms per chain.
 *
 * The benchmark builds a left-associated chain of 1000 FlatMap nodes
 * (the worst case for the interpreter, requiring reassociation) and
 * runs it through the Runtime.  Each iteration constructs and executes
 * one full chain.
 */

import type { BenchmarkDef } from "./runner";
import { asyncSucceed, asyncFlatMap } from "../core/types/asyncEffect";
import { Runtime } from "../core/runtime/runtime";

const CHAIN_LENGTH = 1000;

/**
 * Build a left-associated FlatMap chain of `n` Succeed effects.
 * This is the shape that triggers reassociateFlatMap in the fiber interpreter.
 */
function buildChain(n: number) {
  let eff = asyncSucceed(0);
  for (let i = 0; i < n; i++) {
    eff = asyncFlatMap(eff, (v) => asyncSucceed(v + 1));
  }
  return eff;
}

/** Shared runtime instance — no hooks, minimal overhead. */
const rt = Runtime.make({});

export const benchmarks: BenchmarkDef[] = [
  {
    name: `flatMap chain (${CHAIN_LENGTH} effects)`,
    iterations: 1000,
    warmup: 100,
    fn: () => {
      const eff = buildChain(CHAIN_LENGTH);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success" && exit.value === CHAIN_LENGTH) {
            resolve();
          } else {
            reject(
              new Error(
                `Unexpected exit: ${JSON.stringify(exit)}`
              )
            );
          }
        });
      });
    },
  },
];
