import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { EventBus } from "../eventBus";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeEventRecord } from "../events";

/**
 * **Validates: Requirements 3.3**
 *
 * Propiedad 11: EventBus drop counting
 * Cuando se emiten N eventos con capacidad C (per-subscriber), los drops
 * reportados son max(0, N - C).
 *
 * Generador: Generar N (1-10000) y C (1-1000).
 *
 * Strategy: We create an EventBus, subscribe with a specific per-subscriber
 * capacity C, emit N events synchronously (before any flush runs), then
 * manually call flush() and inspect the drop warning event. The RingBuffer
 * uses power-of-2 capacities, so the actual capacity is nextPow2(C). We
 * account for this when computing expected drops.
 *
 * Key details:
 * - The subscriber's RingBuffer is created with (C, C) meaning both initial
 *   and max capacity are set to C. The actual capacity is nextPow2(C).
 * - When the buffer is full at maxCap, push returns PushStatus.Dropped and
 *   the EventBus increments the subscriber's dropped counter.
 * - On flush, if dropped > 0, a warning event with { dropped: N } is emitted
 *   to the handler before draining the queue, then the counter resets.
 */

const makeEvent = (i: number): RuntimeEvent => ({
  type: "log",
  level: "info",
  message: `evt-${i}`,
});

const makeCtx = (): RuntimeEmitContext => ({
  fiberId: 1,
  scopeId: 1,
});

/**
 * Computes the next power of 2 >= max(2, n), matching RingBuffer's constructor logic.
 */
function nextPow2(n: number): number {
  let v = Math.max(2, n);
  v--;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  v++;
  return v;
}

describe("EventBus drop counting (Property 11)", () => {
  it(
    "when N events are emitted with subscriber capacity C, drops equal max(0, N - actualCap)",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 1_000 }),
          (n, c) => {
            const bus = new EventBus();
            const received: RuntimeEventRecord[] = [];

            bus.subscribe((ev) => received.push(ev), c);

            const actualCap = nextPow2(c);
            const ctx = makeCtx();

            for (let i = 0; i < n; i++) {
              bus.emit(makeEvent(i), ctx);
            }

            bus.flush();

            const expectedDrops = Math.max(0, n - actualCap);
            const dropWarning = received.find(
              (ev) => ev.message === "eventbus.dropped"
            );
            const dataEvents = received.filter(
              (ev) => ev.message !== "eventbus.dropped"
            );

            if (expectedDrops === 0) {
              expect(dropWarning).toBeUndefined();
              expect(dataEvents).toHaveLength(n);
              return;
            }

            expect(dropWarning).toBeDefined();
            expect((dropWarning!.fields as Record<string, unknown>).dropped).toBe(
              expectedDrops
            );
            expect(dataEvents).toHaveLength(actualCap);
          }
        ),
        {
          numRuns: process.env.CI ? 50 : 500,
          endOnFailure: true,
        }
      );
    },
    30_000
  );

  it("drops accumulate correctly across multiple flush cycles", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),   // events per batch
        fc.integer({ min: 2, max: 5 }),      // number of batches
        fc.integer({ min: 1, max: 64 }),     // requested capacity
        (batchSize, batches, c) => {
          const bus = new EventBus();
          const received: RuntimeEventRecord[] = [];

          bus.subscribe((ev) => received.push(ev), c);

          const actualCap = nextPow2(c);

          for (let batch = 0; batch < batches; batch++) {
            // Clear received for this batch
            received.length = 0;

            const ctx = makeCtx();
            for (let i = 0; i < batchSize; i++) {
              bus.emit(makeEvent(batch * batchSize + i), ctx);
            }

            // Flush this batch
            bus.flush();

            const expectedDrops = Math.max(0, batchSize - actualCap);

            if (expectedDrops === 0) {
              const dropWarning = received.find(
                (ev) => ev.message === "eventbus.dropped"
              );
              expect(dropWarning).toBeUndefined();
            } else {
              const dropWarning = received.find(
                (ev) => ev.message === "eventbus.dropped"
              );
              expect(dropWarning).toBeDefined();
              expect(
                (dropWarning!.fields as Record<string, unknown>).dropped
              ).toBe(expectedDrops);
            }

            // Data events delivered should be min(batchSize, actualCap)
            const dataEvents = received.filter(
              (ev) => ev.message !== "eventbus.dropped"
            );
            expect(dataEvents).toHaveLength(Math.min(batchSize, actualCap));
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("with zero drops, no drop warning event is emitted", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),   // N events
        (n) => {
          const bus = new EventBus();
          const received: RuntimeEventRecord[] = [];

          // Use a capacity large enough to hold all events (no drops)
          const c = n;
          bus.subscribe((ev) => received.push(ev), c);

          const ctx = makeCtx();
          for (let i = 0; i < n; i++) {
            bus.emit(makeEvent(i), ctx);
          }

          bus.flush();

          // No drop warning should exist
          const dropWarning = received.find(
            (ev) => ev.message === "eventbus.dropped"
          );
          expect(dropWarning).toBeUndefined();

          // All events delivered
          expect(received).toHaveLength(n);
        }
      ),
      { numRuns: 200 }
    );
  });
});
