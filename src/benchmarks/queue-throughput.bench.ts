/**
 * Benchmark: Queue offer/take — 10k operations, target < 10ms total.
 *
 * Validates Requirement 11.3: latency of offer/take on a Queue with
 * 10,000 operations, with a target of less than 10ms total.
 *
 * Three scenarios are measured:
 *
 * 1. **Sequential offer then take** — fills the queue, then drains it.
 *    Measures raw buffer throughput without contention.
 *
 * 2. **Ping-pong (producer/consumer)** — alternates offer and take so
 *    that the fast-path (taker waiting → direct handoff) is exercised.
 *
 * 3. **Sliding strategy under pressure** — offers into a full sliding
 *    queue, exercising the drop-oldest path.
 */

import type { BenchmarkDef } from "./runner";
import { asyncFlatMap, asyncSucceed, unit } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { bounded, type Queue } from "../core/stream/queue";
import { Runtime } from "../core/runtime/runtime";

const OPS = 10_000;

/** Shared runtime — no hooks, minimal overhead. */
const rt = Runtime.make({});

/**
 * Build an effect that creates a bounded queue, offers N values,
 * then takes N values sequentially.
 */
function buildSequentialBench(n: number): Async<unknown, unknown, void> {
  return asyncFlatMap(bounded<number>(n), (q) => {
    // Offer phase: chain N offers
    let offerChain: Async<unknown, unknown, unknown> = unit();
    for (let i = 0; i < n; i++) {
      const val = i;
      offerChain = asyncFlatMap(offerChain, () => q.offer(val));
    }

    // Take phase: chain N takes
    let takeChain: Async<unknown, unknown, unknown> = unit();
    for (let i = 0; i < n; i++) {
      takeChain = asyncFlatMap(takeChain, () => q.take());
    }

    return asyncFlatMap(offerChain, () => asyncFlatMap(takeChain, () => unit()));
  });
}

/**
 * Build an effect that creates a queue of capacity 1 and alternates
 * offer/take N times (ping-pong pattern). This exercises the direct
 * handoff path where a taker is already waiting.
 */
function buildPingPongBench(n: number): Async<unknown, unknown, void> {
  return asyncFlatMap(bounded<number>(1), (q) => {
    let chain: Async<unknown, unknown, unknown> = unit();
    for (let i = 0; i < n; i++) {
      const val = i;
      chain = asyncFlatMap(chain, () =>
        asyncFlatMap(q.offer(val), () => q.take())
      );
    }
    return asyncFlatMap(chain, () => unit());
  });
}

/**
 * Build an effect that creates a sliding queue of small capacity and
 * offers N values (most will slide), then drains whatever remains.
 */
function buildSlidingBench(n: number, capacity: number): Async<unknown, unknown, void> {
  return asyncFlatMap(bounded<number>(capacity, "sliding"), (q) => {
    // Offer N values into a small sliding queue
    let offerChain: Async<unknown, unknown, unknown> = unit();
    for (let i = 0; i < n; i++) {
      const val = i;
      offerChain = asyncFlatMap(offerChain, () => q.offer(val));
    }

    // Drain whatever is in the buffer
    let drainChain: Async<unknown, unknown, unknown> = unit();
    for (let i = 0; i < capacity; i++) {
      drainChain = asyncFlatMap(drainChain, () => q.take());
    }

    return asyncFlatMap(offerChain, () => asyncFlatMap(drainChain, () => unit()));
  });
}

export const benchmarks: BenchmarkDef[] = [
  // --- Scenario 1: sequential fill then drain ---
  {
    name: `queue sequential offer+take (${OPS.toLocaleString()} ops)`,
    iterations: 100,
    warmup: 20,
    fn: () => {
      const eff = buildSequentialBench(OPS);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },

  // --- Scenario 2: ping-pong (offer then take, capacity 1) ---
  {
    name: `queue ping-pong offer/take (${OPS.toLocaleString()} ops)`,
    iterations: 100,
    warmup: 20,
    fn: () => {
      const eff = buildPingPongBench(OPS);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },

  // --- Scenario 3: sliding strategy under pressure ---
  {
    name: `queue sliding (${OPS.toLocaleString()} offers, capacity 64)`,
    iterations: 100,
    warmup: 20,
    fn: () => {
      const eff = buildSlidingBench(OPS, 64);
      return new Promise<void>((resolve, reject) => {
        rt.unsafeRunAsync(eff, (exit) => {
          if (exit._tag === "Success") resolve();
          else reject(new Error(`Unexpected exit: ${JSON.stringify(exit)}`));
        });
      });
    },
  },
];
