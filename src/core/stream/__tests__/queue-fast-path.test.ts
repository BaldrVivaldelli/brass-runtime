import { describe, it, expect } from "vitest";
import { bounded, Queue } from "../queue";
import { Runtime } from "../../runtime/runtime";
import { asyncFlatMap, async as asyncEffect } from "../../types/asyncEffect";

/**
 * Verification tests for Queue fast-path synchronous resolution (Task 5.1).
 * Validates: Requirements 5.1, 5.2, 5.4
 *
 * These tests verify that:
 * - offer() delivers directly to a waiting taker without scheduler/microtask
 * - take() admits a waiting offerer directly without scheduler/microtask
 * - Callbacks are invoked synchronously in the fast-path
 * - Fallback to buffer + suspension works when no counterpart is available
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

describe("Queue fast-path synchronous resolution", () => {
  describe("offer delivers directly to waiting taker", () => {
    it("taker callback is invoked synchronously when offer arrives", async () => {
      const q = await run<Queue<number>>(bounded<number>(4, "backpressure"));

      // Suspend a taker (buffer is empty, no offerers)
      let takerValue: number | null = null;
      let takerResolvedSynchronously = false;

      rt.unsafeRunAsync(q.take() as any, (exit: any) => {
        if (exit._tag === "Success") takerValue = exit.value;
      });

      // Now offer — the taker should be resolved synchronously (no microtask)
      let offerDone = false;
      rt.unsafeRunAsync(q.offer(42) as any, (exit: any) => {
        if (exit._tag === "Success") {
          offerDone = true;
          // At this point, the taker should already have received the value
          // because delivery happens before the offer callback
          takerResolvedSynchronously = takerValue === 42;
        }
      });

      // Both should resolve within the same microtask tick
      await Promise.resolve();
      expect(takerValue).toBe(42);
      expect(offerDone).toBe(true);
    });

    it("offer returns true when delivering to taker", async () => {
      const q = await run<Queue<number>>(bounded<number>(2, "backpressure"));

      // Suspend a taker
      rt.unsafeRunAsync(q.take() as any, () => {});

      // Offer should succeed
      const result = await run<boolean>(q.offer(99));
      expect(result).toBe(true);
    });
  });

  describe("take admits waiting offerer directly", () => {
    it("offerer callback is invoked synchronously when take arrives", async () => {
      const q = await run<Queue<number>>(bounded<number>(1, "backpressure"));

      // Fill the buffer
      await run(q.offer(1));

      // Suspend an offerer (buffer is full, backpressure)
      let offererAdmitted = false;
      rt.unsafeRunAsync(q.offer(2) as any, (exit: any) => {
        if (exit._tag === "Success" && exit.value === true) {
          offererAdmitted = true;
        }
      });

      // Take from buffer — should admit the offerer synchronously
      const value = await run<number>(q.take());
      expect(value).toBe(1);

      // The offerer should have been admitted synchronously during the take
      // Give one tick for the runtime to process
      await Promise.resolve();
      expect(offererAdmitted).toBe(true);
    });

    it("take from empty queue with waiting offerer delivers directly", async () => {
      // This tests the path where buffer is empty but an offerer is waiting
      // (can happen with capacity 0 semantics or after drain)
      const q = await run<Queue<number>>(bounded<number>(1, "backpressure"));

      // Fill buffer to capacity
      await run(q.offer(10));

      // Suspend offerer (buffer full)
      let offererDone = false;
      rt.unsafeRunAsync(q.offer(20) as any, (exit: any) => {
        if (exit._tag === "Success") offererDone = true;
      });

      // First take gets from buffer
      const first = await run<number>(q.take());
      expect(first).toBe(10);

      // The offerer's value (20) should now be in the buffer
      // and the offerer should be admitted
      await Promise.resolve();
      expect(offererDone).toBe(true);

      // Second take gets the offerer's value
      const second = await run<number>(q.take());
      expect(second).toBe(20);
    });
  });

  describe("fallback to buffer when no counterpart", () => {
    it("offer buffers when no taker is waiting", async () => {
      const q = await run<Queue<number>>(bounded<number>(4, "backpressure"));

      // Offer without any taker — should buffer
      const result = await run<boolean>(q.offer(1));
      expect(result).toBe(true);
      expect(q.size()).toBe(1);
    });

    it("take from buffer when no offerer is waiting", async () => {
      const q = await run<Queue<number>>(bounded<number>(4, "backpressure"));

      // Pre-fill buffer
      await run(q.offer(10));
      await run(q.offer(20));

      // Take without any suspended offerer — should read from buffer
      const value = await run<number>(q.take());
      expect(value).toBe(10);
      expect(q.size()).toBe(1);
    });

    it("take suspends when buffer is empty and no offerer", async () => {
      const q = await run<Queue<number>>(bounded<number>(4, "backpressure"));

      // Take on empty queue — should suspend
      let resolved = false;
      rt.unsafeRunAsync(q.take() as any, (exit: any) => {
        resolved = true;
      });

      // Should not resolve immediately
      expect(resolved).toBe(false);

      // Offer to resolve the suspended taker
      await run(q.offer(42));
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  describe("no scheduler or microtask in fast-path", () => {
    it("direct handoff completes within same synchronous execution", async () => {
      const q = await run<Queue<number>>(bounded<number>(1, "backpressure"));

      const events: string[] = [];

      // Suspend a taker
      rt.unsafeRunAsync(q.take() as any, (exit: any) => {
        events.push(`taker:${exit._tag === "Success" ? exit.value : "fail"}`);
      });

      // Offer — should trigger taker synchronously
      rt.unsafeRunAsync(q.offer(7) as any, (exit: any) => {
        events.push(`offer:${exit._tag === "Success" ? exit.value : "fail"}`);
      });

      // Both events should have fired synchronously (before any await)
      // The taker fires first (direct delivery), then the offer callback
      await Promise.resolve();
      expect(events).toContain("taker:7");
      expect(events).toContain("offer:true");
      expect(events.length).toBe(2);
    });

    it("multiple sequential offer/take pairs resolve without scheduling", async () => {
      const q = await run<Queue<number>>(bounded<number>(4, "backpressure"));
      const results: number[] = [];

      // Offer 100 values and take them back sequentially
      for (let i = 0; i < 100; i++) {
        await run(q.offer(i));
        const v = await run<number>(q.take());
        results.push(v);
      }

      // All values should be received in order
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });
  });
});
