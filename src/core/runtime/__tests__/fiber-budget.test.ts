/**
 * Benchmark: Evaluate optimal DEFAULT_BUDGET for the fiber interpreter.
 *
 * Creates chains of 1000 FlatMap effects and measures latency with
 * different budget values: 1024, 2048, 4096, 8192.
 *
 * Run with: npx vitest run src/core/runtime/__tests__/fiber-budget.test.ts
 */
import { describe, it, expect, afterAll } from "vitest";
import { asyncFlatMap, asyncSucceed, Async } from "../../types/asyncEffect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";
import { setBenchmarkBudget } from "../fiber";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHAIN_LENGTH = 1000;
const ITERATIONS = 50;
const BUDGET_VALUES = [1024, 2048, 4096, 8192] as const;

/** Build a chain of `n` FlatMap(succeed(i), x => succeed(x+1)) */
function buildFlatMapChain(n: number): Async<unknown, never, number> {
  let effect: Async<unknown, never, number> = asyncSucceed(0);
  for (let i = 0; i < n; i++) {
    effect = asyncFlatMap(effect, (x) => asyncSucceed(x + 1));
  }
  return effect;
}

/** Run a single effect and return the elapsed time in ms */
async function timeEffect(rt: Runtime<unknown>, effect: Async<unknown, never, number>): Promise<number> {
  const start = performance.now();
  await rt.toPromise(effect);
  return performance.now() - start;
}

/** Compute statistics from an array of numbers */
function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { mean, median, min, max, p95 };
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe("Fiber DEFAULT_BUDGET benchmark — 1000 FlatMap chain", () => {
  // Pre-build the chain once (it's immutable)
  const chain = buildFlatMapChain(CHAIN_LENGTH);

  // Store results for comparison at the end
  const results: Record<number, ReturnType<typeof stats>> = {};

  // Always reset budget after all tests
  afterAll(() => {
    setBenchmarkBudget(undefined);
  });

  for (const budget of BUDGET_VALUES) {
    it(`budget = ${budget}`, async () => {
      // Set the benchmark budget override
      setBenchmarkBudget(budget);

      const times: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const scheduler = new Scheduler();
        const rt = new Runtime({ env: {}, scheduler });
        const elapsed = await timeEffect(rt, chain);
        times.push(elapsed);
      }

      // Reset budget override
      setBenchmarkBudget(undefined);

      const s = stats(times);
      results[budget] = s;

      console.log(
        `  budget=${budget}  mean=${s.mean.toFixed(3)}ms  median=${s.median.toFixed(3)}ms  ` +
        `min=${s.min.toFixed(3)}ms  max=${s.max.toFixed(3)}ms  p95=${s.p95.toFixed(3)}ms`
      );

      // Sanity: the chain should complete successfully
      expect(s.mean).toBeGreaterThan(0);
      expect(s.median).toBeGreaterThan(0);
    }, 30_000); // generous timeout for 50 iterations
  }

  it("summary — select optimal budget", () => {
    // Print a summary table
    console.log("\n=== BUDGET BENCHMARK SUMMARY ===");
    console.log("budget  | mean (ms) | median (ms) | min (ms) | max (ms) | p95 (ms)");
    console.log("--------|-----------|-------------|----------|----------|----------");

    let bestBudget = BUDGET_VALUES[0];
    let bestMedian = Infinity;

    for (const budget of BUDGET_VALUES) {
      const s = results[budget];
      if (s) {
        console.log(
          `${String(budget).padEnd(7)} | ${s.mean.toFixed(3).padStart(9)} | ${s.median.toFixed(3).padStart(11)} | ` +
          `${s.min.toFixed(3).padStart(8)} | ${s.max.toFixed(3).padStart(8)} | ${s.p95.toFixed(3).padStart(8)}`
        );
        if (s.median < bestMedian) {
          bestMedian = s.median;
          bestBudget = budget;
        }
      }
    }

    console.log(`\n✅ Optimal budget based on lowest median: ${bestBudget} (median=${bestMedian.toFixed(3)}ms)`);
    console.log("=================================\n");

    // The test passes as long as we got results
    expect(Object.keys(results).length).toBe(BUDGET_VALUES.length);
  });
});
