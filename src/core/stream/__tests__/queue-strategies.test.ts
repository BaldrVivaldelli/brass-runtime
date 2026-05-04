import { describe, it, expect } from "vitest";
import { bounded, Queue, QueueClosed } from "../queue";
import { Runtime } from "../../runtime/runtime";
import { asyncFlatMap, asyncSucceed, async as asyncEffect } from "../../types/asyncEffect";

/**
 * Verification tests for Queue strategies after optimizations (Task 5.1.3).
 * Validates: Requirements 5.1, 5.2, 5.4, 5.5
 *
 * Verifies that the three Queue strategies (backpressure, dropping, sliding)
 * still work correctly after the optimizations in tasks 5.1.1 and 5.1.2:
 * - 5.1.1: Moving canceler closure creation to the suspension path only
 * - 5.1.2: Simplifying flush() by eliminating redundant calls
 */

const rt = Runtime.make({});

// Helper: run an effect and return its result
function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// 1. Backpressure strategy
// ---------------------------------------------------------------------------
describe("Queue backpressure strategy", () => {
  it("basic offer/take works", async () => {
    const result = await run<number>(
      asyncFlatMap(bounded<number>(4, "backpressure"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            asyncFlatMap(q.take(), (a) =>
              asyncFlatMap(q.take(), (b) => asyncSucceed(a * 10 + b))
            )
          )
        )
      )
    );
    expect(result).toBe(12); // FIFO: 1 then 2
  });

  it("when buffer is full, offer suspends until a take frees space", async () => {
    // Use a separate runtime call to coordinate the suspended offer
    const q = await run<Queue<number>>(bounded<number>(2, "backpressure"));

    // Fill the buffer
    expect(await run(q.offer(1))).toBe(true);
    expect(await run(q.offer(2))).toBe(true);

    // Buffer is full. Start a suspended offer in the background.
    let offerResolved = false;
    let offerResult: boolean | null = null;
    rt.unsafeRunAsync(q.offer(3) as any, (exit: any) => {
      offerResolved = true;
      if (exit._tag === "Success") offerResult = exit.value;
    });

    // The offer should be suspended (not yet resolved)
    expect(offerResolved).toBe(false);

    // Take one element to free space
    const a = await run<number>(q.take());
    expect(a).toBe(1);

    // Give the runtime a tick to process the resumed offer
    await new Promise((r) => setTimeout(r, 20));

    // The suspended offer should have resolved
    expect(offerResolved).toBe(true);
    expect(offerResult).toBe(true);

    // Take the remaining elements
    const b = await run<number>(q.take());
    const c = await run<number>(q.take());
    expect([b, c]).toEqual([2, 3]);
  });

  it("multiple suspended offers resume in order when space becomes available", async () => {
    const q = await run<Queue<number>>(bounded<number>(1, "backpressure"));

    // Fill the buffer
    expect(await run(q.offer(1))).toBe(true);

    // Buffer full (capacity 1). Start two suspended offers.
    let offer2Result: boolean | null = null;
    let offer3Result: boolean | null = null;

    rt.unsafeRunAsync(q.offer(2) as any, (exit: any) => {
      if (exit._tag === "Success") offer2Result = exit.value;
    });

    // Small delay to ensure offer(2) suspends before offer(3)
    await new Promise((r) => setTimeout(r, 5));

    rt.unsafeRunAsync(q.offer(3) as any, (exit: any) => {
      if (exit._tag === "Success") offer3Result = exit.value;
    });

    // Take all three elements in order
    const a = await run<number>(q.take());
    await new Promise((r) => setTimeout(r, 10));
    const b = await run<number>(q.take());
    await new Promise((r) => setTimeout(r, 10));
    const c = await run<number>(q.take());

    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(offer2Result).toBe(true);
    expect(offer3Result).toBe(true);
  });

  it("shutdown releases suspended offers (returning false)", async () => {
    const q = await run<Queue<number>>(bounded<number>(1, "backpressure"));

    // Fill the buffer
    expect(await run(q.offer(1))).toBe(true);

    // Buffer full. Start a suspended offer in the background.
    let offerResult: boolean | null = null;
    rt.unsafeRunAsync(q.offer(2) as any, (exit: any) => {
      if (exit._tag === "Success") offerResult = exit.value;
    });

    // Shutdown the queue — the suspended offer should get false
    q.shutdown();

    // Give time for the callback to fire
    await new Promise((r) => setTimeout(r, 20));

    expect(offerResult).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Dropping strategy
// ---------------------------------------------------------------------------
describe("Queue dropping strategy", () => {
  it("basic offer/take works", async () => {
    const result = await run<number>(
      asyncFlatMap(bounded<number>(4, "dropping"), (q) =>
        asyncFlatMap(q.offer(10), () =>
          asyncFlatMap(q.offer(20), () => q.take())
        )
      )
    );
    expect(result).toBe(10); // FIFO
  });

  it("when buffer is full, offer returns false immediately (element dropped)", async () => {
    const result = await run<boolean>(
      asyncFlatMap(bounded<number>(2, "dropping"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            // Buffer full — this should return false
            q.offer(3)
          )
        )
      )
    );
    expect(result).toBe(false);
  });

  it("elements already in buffer are preserved after a dropped offer", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(2, "dropping"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            asyncFlatMap(q.offer(3), (_dropped) =>
              asyncFlatMap(q.take(), (a) =>
                asyncFlatMap(q.take(), (b) => asyncSucceed([a, b]))
              )
            )
          )
        )
      )
    );
    // Only the first two elements should be in the buffer; 3 was dropped
    expect(result).toEqual([1, 2]);
  });

  it("take retrieves elements in FIFO order", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(4, "dropping"), (q) =>
        asyncFlatMap(q.offer(10), () =>
          asyncFlatMap(q.offer(20), () =>
            asyncFlatMap(q.offer(30), () =>
              asyncFlatMap(q.take(), (a) =>
                asyncFlatMap(q.take(), (b) =>
                  asyncFlatMap(q.take(), (c) => asyncSucceed([a, b, c]))
                )
              )
            )
          )
        )
      )
    );
    expect(result).toEqual([10, 20, 30]);
  });
});

// ---------------------------------------------------------------------------
// 3. Sliding strategy
// ---------------------------------------------------------------------------
describe("Queue sliding strategy", () => {
  it("basic offer/take works", async () => {
    const result = await run<number>(
      asyncFlatMap(bounded<number>(4, "sliding"), (q) =>
        asyncFlatMap(q.offer(5), () =>
          asyncFlatMap(q.offer(6), () => q.take())
        )
      )
    );
    expect(result).toBe(5); // FIFO
  });

  it("when buffer is full, offer drops oldest and accepts new (returns true)", async () => {
    const result = await run<boolean>(
      asyncFlatMap(bounded<number>(2, "sliding"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            // Buffer full — sliding should drop oldest and accept new, returning true
            q.offer(3)
          )
        )
      )
    );
    expect(result).toBe(true);
  });

  it("after sliding, take returns the most recent elements", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(2, "sliding"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            asyncFlatMap(q.offer(3), () =>
              // 1 was dropped (oldest), buffer has [2, 3]
              asyncFlatMap(q.take(), (a) =>
                asyncFlatMap(q.take(), (b) => asyncSucceed([a, b]))
              )
            )
          )
        )
      )
    );
    expect(result).toEqual([2, 3]);
  });

  it("correct behavior with capacity 1 (always has latest element)", async () => {
    const result = await run<number>(
      asyncFlatMap(bounded<number>(1, "sliding"), (q) =>
        asyncFlatMap(q.offer(10), () =>
          asyncFlatMap(q.offer(20), () =>
            asyncFlatMap(q.offer(30), () =>
              // Only the latest element (30) should remain
              q.take()
            )
          )
        )
      )
    );
    expect(result).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 4. Common behaviors
// ---------------------------------------------------------------------------
describe("Queue common behaviors", () => {
  it("shutdown causes subsequent takes to fail with QueueClosed", async () => {
    await expect(
      run<number>(
        asyncFlatMap(bounded<number>(4, "backpressure"), (q) => {
          q.shutdown();
          return q.take();
        })
      )
    ).rejects.toMatchObject({ _tag: "QueueClosed" });
  });

  it("shutdown causes subsequent offers to return false", async () => {
    const result = await run<boolean>(
      asyncFlatMap(bounded<number>(4, "backpressure"), (q) => {
        q.shutdown();
        return q.offer(1);
      })
    );
    expect(result).toBe(false);
  });

  it("size() reflects current buffer state", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(4, "backpressure"), (q) => {
        const s0 = q.size();
        return asyncFlatMap(q.offer(1), () => {
          const s1 = q.size();
          return asyncFlatMap(q.offer(2), () => {
            const s2 = q.size();
            return asyncFlatMap(q.take(), () => {
              const s3 = q.size();
              return asyncSucceed([s0, s1, s2, s3]);
            });
          });
        });
      })
    );
    expect(result).toEqual([0, 1, 2, 1]);
  });

  it("size() works correctly for dropping strategy", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(2, "dropping"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            asyncFlatMap(q.offer(3), () => {
              // 3 was dropped, size should still be 2
              const s = q.size();
              return asyncSucceed([s]);
            })
          )
        )
      )
    );
    expect(result).toEqual([2]);
  });

  it("size() works correctly for sliding strategy", async () => {
    const result = await run<number[]>(
      asyncFlatMap(bounded<number>(2, "sliding"), (q) =>
        asyncFlatMap(q.offer(1), () =>
          asyncFlatMap(q.offer(2), () =>
            asyncFlatMap(q.offer(3), () => {
              // 1 was dropped, 3 was added, size should still be 2
              const s = q.size();
              return asyncSucceed([s]);
            })
          )
        )
      )
    );
    expect(result).toEqual([2]);
  });
});
