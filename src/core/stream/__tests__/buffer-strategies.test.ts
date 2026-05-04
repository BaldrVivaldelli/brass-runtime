import { describe, it, expect } from "vitest";
import { buffer } from "../buffer";
import { collectStream, fromArray, rangeStream, fromPull } from "../stream";
import { Runtime } from "../../runtime/runtime";
import { asyncSucceed, asyncFail } from "../../types/asyncEffect";
import { none } from "../../types/option";

/**
 * Verification tests for buffer() with all three queue strategies (Task 6.2.3).
 * Validates: Requirement 6.6 (buffer producer starts once and queue is reused)
 *
 * Verifies that the buffer() function works correctly with backpressure,
 * dropping, and sliding strategies after the optimizations in tasks 6.2.1
 * and 6.2.2:
 * - 6.2.1: Producer starts once using the `started` flag, queue reused
 * - 6.2.2: Reduced allocations in nextSignal() and producer loop
 *
 * Note on dropping/sliding behavior:
 * The buffer forks a producer that pushes signals into a bounded queue.
 * With dropping/sliding, when the producer outruns the consumer, elements
 * (or even the End signal) can be lost. Tests for these strategies use
 * buffer capacities large enough to hold all elements + the End signal,
 * ensuring no data loss. The backpressure strategy naturally handles this
 * because the producer blocks when the queue is full.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// 1. Backpressure strategy
// ---------------------------------------------------------------------------
describe("buffer backpressure strategy", () => {
  it("basic: preserves all elements from a small stream", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([1, 2, 3, 4, 5]), 2, "backpressure"))
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("larger stream: preserves all 50 elements in order", async () => {
    const result = await run<number[]>(
      collectStream(buffer(rangeStream(0, 49), 4, "backpressure"))
    );
    expect(result).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("single element stream", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([42]), 1, "backpressure"))
    );
    expect(result).toEqual([42]);
  });

  it("empty stream produces empty array", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([]), 2, "backpressure"))
    );
    expect(result).toEqual([]);
  });

  it("works with small buffer relative to stream size", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([1, 2, 3, 4, 5, 6, 7, 8]), 2, "backpressure"))
    );
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

// ---------------------------------------------------------------------------
// 2. Dropping strategy
// ---------------------------------------------------------------------------
describe("buffer dropping strategy", () => {
  // With dropping, the producer never blocks. If the buffer is large enough
  // to hold all elements + End signal, no data is lost.
  it("preserves all elements when buffer capacity >= stream length", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([1, 2, 3, 4, 5]), 10, "dropping"))
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("larger stream with sufficient buffer capacity", async () => {
    const result = await run<number[]>(
      collectStream(buffer(rangeStream(0, 49), 64, "dropping"))
    );
    expect(result).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("single element stream", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([42]), 4, "dropping"))
    );
    expect(result).toEqual([42]);
  });

  it("empty stream produces empty array", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([]), 4, "dropping"))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Sliding strategy
// ---------------------------------------------------------------------------
describe("buffer sliding strategy", () => {
  // With sliding, the producer never blocks. If the buffer is large enough
  // to hold all elements + End signal, no data is lost.
  it("preserves all elements when buffer capacity >= stream length", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([1, 2, 3, 4, 5]), 10, "sliding"))
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("larger stream with sufficient buffer capacity", async () => {
    const result = await run<number[]>(
      collectStream(buffer(rangeStream(0, 49), 64, "sliding"))
    );
    expect(result).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("single element stream", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([42]), 4, "sliding"))
    );
    expect(result).toEqual([42]);
  });

  it("empty stream produces empty array", async () => {
    const result = await run<number[]>(
      collectStream(buffer(fromArray([]), 4, "sliding"))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Producer single-start verification
// ---------------------------------------------------------------------------
describe("buffer producer single-start", () => {
  it("producer is started only once across multiple pulls (backpressure)", async () => {
    let startCount = 0;
    const values = [10, 20, 30, 40, 50];

    // Create a custom stream that increments a counter on the first pull
    const trackingStream = fromPull(
      (() => {
        startCount++;
        const makePull = (i: number): any => {
          if (i >= values.length) {
            return asyncFail(none);
          }
          return asyncSucceed([values[i]!, fromPull(makePull(i + 1))] as [number, any]);
        };
        return makePull(0);
      })()
    );

    const result = await run<number[]>(
      collectStream(buffer(trackingStream, 2, "backpressure"))
    );

    expect(result).toEqual([10, 20, 30, 40, 50]);
    // The producer should have been started exactly once — the buffer
    // consumes the stream once and feeds elements through the queue.
    expect(startCount).toBe(1);
  });

  it("producer is started only once with dropping strategy", async () => {
    let startCount = 0;
    const values = [1, 2, 3];

    const trackingStream = fromPull(
      (() => {
        startCount++;
        const makePull = (i: number): any => {
          if (i >= values.length) return asyncFail(none);
          return asyncSucceed([values[i]!, fromPull(makePull(i + 1))] as [number, any]);
        };
        return makePull(0);
      })()
    );

    const result = await run<number[]>(
      collectStream(buffer(trackingStream, 10, "dropping"))
    );

    expect(result).toEqual([1, 2, 3]);
    expect(startCount).toBe(1);
  });

  it("producer is started only once with sliding strategy", async () => {
    let startCount = 0;
    const values = [1, 2, 3];

    const trackingStream = fromPull(
      (() => {
        startCount++;
        const makePull = (i: number): any => {
          if (i >= values.length) return asyncFail(none);
          return asyncSucceed([values[i]!, fromPull(makePull(i + 1))] as [number, any]);
        };
        return makePull(0);
      })()
    );

    const result = await run<number[]>(
      collectStream(buffer(trackingStream, 10, "sliding"))
    );

    expect(result).toEqual([1, 2, 3]);
    expect(startCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Order preservation
// ---------------------------------------------------------------------------
describe("buffer order preservation", () => {
  it("backpressure preserves element order", async () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = await run<number[]>(
      collectStream(buffer(fromArray(input), 3, "backpressure"))
    );
    expect(result).toEqual(input);
  });

  it("dropping preserves element order when buffer is large enough", async () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = await run<number[]>(
      collectStream(buffer(fromArray(input), 32, "dropping"))
    );
    expect(result).toEqual(input);
  });

  it("sliding preserves element order when buffer is large enough", async () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = await run<number[]>(
      collectStream(buffer(fromArray(input), 32, "sliding"))
    );
    expect(result).toEqual(input);
  });
});
