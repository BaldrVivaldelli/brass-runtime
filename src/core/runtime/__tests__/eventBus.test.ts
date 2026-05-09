import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../eventBus";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeEventRecord } from "../events";

/**
 * Verification tests for EventBus optimizations (Task 2.2.4).
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */

const makeEvent = (msg: string): RuntimeEvent => ({
  type: "log",
  level: "info",
  message: msg,
});

const makeCtx = (fiberId = 1): RuntimeEmitContext => ({
  fiberId,
  scopeId: 1,
});

describe("EventBus optimizations", () => {
  describe("events delivered correctly with subscribers", () => {
    it("delivers emitted events to a subscriber via flush", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      bus.subscribe((ev) => received.push(ev));
      bus.emit(makeEvent("hello"), makeCtx());
      bus.emit(makeEvent("world"), makeCtx());

      // flush is scheduled via queueMicrotask — await it
      await Promise.resolve();

      expect(received).toHaveLength(2);
      expect(received[0].message).toBe("hello");
      expect(received[1].message).toBe("world");
    });

    it("delivers events to multiple subscribers", async () => {
      const bus = new EventBus();
      const r1: RuntimeEventRecord[] = [];
      const r2: RuntimeEventRecord[] = [];

      bus.subscribe((ev) => r1.push(ev));
      bus.subscribe((ev) => r2.push(ev));
      bus.emit(makeEvent("broadcast"), makeCtx());

      await Promise.resolve();

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r1[0].message).toBe("broadcast");
      expect(r2[0].message).toBe("broadcast");
    });
  });

  describe("event/context field preservation", () => {
    it("keeps event fiberId/scopeId when context has ambient ids", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      bus.subscribe((ev) => received.push(ev));
      bus.emit(
        { type: "fiber.start", fiberId: 2, parentFiberId: 1, scopeId: 20 },
        { fiberId: 1, scopeId: 10, traceId: "trace", spanId: "span" }
      );

      await Promise.resolve();

      expect(received).toHaveLength(1);
      expect(received[0].fiberId).toBe(2);
      expect(received[0].scopeId).toBe(20);
      expect(received[0].contextFiberId).toBe(1);
      expect(received[0].contextScopeId).toBe(10);
      expect(received[0].traceId).toBe("trace");
      expect(received[0].spanId).toBe("span");
    });

    it("subscribeHooks forwards the original event and ambient context to RuntimeHooks", async () => {
      const bus = new EventBus();
      const received: Array<{ ev: RuntimeEvent; ctx: RuntimeEmitContext }> = [];

      bus.subscribeHooks({
        emit: (ev, ctx) => received.push({ ev, ctx }),
      });
      bus.emit(
        { type: "fiber.start", fiberId: 2, parentFiberId: 1, scopeId: 20 },
        { fiberId: 1, scopeId: 10, traceId: "trace", spanId: "span", parentSpanId: "parent-span" }
      );

      await Promise.resolve();

      expect(received).toHaveLength(1);
      expect(received[0].ev).toMatchObject({ type: "fiber.start", fiberId: 2, parentFiberId: 1, scopeId: 20 });
      expect(received[0].ctx).toEqual({
        fiberId: 1,
        scopeId: 10,
        traceId: "trace",
        spanId: "span",
        parentSpanId: "parent-span",
      });
    });
  });

  describe("FIFO ordering", () => {
    it("events are delivered in the order they were emitted", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      bus.subscribe((ev) => received.push(ev));

      for (let i = 0; i < 10; i++) {
        bus.emit(makeEvent(`msg-${i}`), makeCtx());
      }

      await Promise.resolve();

      expect(received).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(received[i].message).toBe(`msg-${i}`);
      }

      // Sequence numbers should be strictly increasing
      for (let i = 1; i < received.length; i++) {
        expect(received[i].seq).toBeGreaterThan(received[i - 1].seq);
      }
    });
  });

  describe("early return when no subscribers (zero-cost)", () => {
    it("does not increment seq when there are no subscribers", () => {
      const bus = new EventBus();

      // Emit several events with no subscribers
      bus.emit(makeEvent("ignored-1"), makeCtx());
      bus.emit(makeEvent("ignored-2"), makeCtx());
      bus.emit(makeEvent("ignored-3"), makeCtx());

      // Now subscribe and emit — seq should start at 1 (not 4)
      const received: RuntimeEventRecord[] = [];
      bus.subscribe((ev) => received.push(ev));
      bus.emit(makeEvent("first-real"), makeCtx());
      bus.flush();

      expect(received).toHaveLength(1);
      expect(received[0].seq).toBe(1);
    });

    it("does not schedule microtask when there are no subscribers", async () => {
      const bus = new EventBus();
      const spy = vi.spyOn(globalThis, "queueMicrotask");

      bus.emit(makeEvent("no-sub"), makeCtx());

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("cached flush closure (boundFlush)", () => {
    it("uses the same closure reference for queueMicrotask across emits", async () => {
      const bus = new EventBus();
      const calls: Array<() => void> = [];
      const origQM = globalThis.queueMicrotask;
      globalThis.queueMicrotask = (cb: () => void) => {
        calls.push(cb);
        origQM(cb);
      };

      try {
        bus.subscribe(() => {});

        bus.emit(makeEvent("a"), makeCtx());
        // Wait for flush to complete so flushScheduled resets
        await Promise.resolve();

        bus.emit(makeEvent("b"), makeCtx());
        await Promise.resolve();

        // Both calls should use the same cached closure
        expect(calls.length).toBe(2);
        expect(calls[0]).toBe(calls[1]);
      } finally {
        globalThis.queueMicrotask = origQM;
      }
    });

    it("flush still works correctly via the cached closure", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      bus.subscribe((ev) => received.push(ev));
      bus.emit(makeEvent("cached-flush-test"), makeCtx());

      await Promise.resolve();

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("cached-flush-test");
    });
  });

  describe("drop counting with full RingBuffer", () => {
    it("reports drops when RingBuffer is full", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      // Subscribe with a very small capacity (2 is the minimum power of 2)
      bus.subscribe((ev) => received.push(ev), 2);

      // Emit more events than the capacity
      for (let i = 0; i < 5; i++) {
        bus.emit(makeEvent(`evt-${i}`), makeCtx());
      }

      await Promise.resolve();

      // Should have received a drop warning event + the events that fit
      const dropWarning = received.find(
        (ev) => ev.message === "eventbus.dropped"
      );
      expect(dropWarning).toBeDefined();
      expect(dropWarning!.fields).toBeDefined();
      expect((dropWarning!.fields as Record<string, unknown>).dropped).toBeGreaterThan(0);
    });
  });

  describe("unsubscribe stops delivery", () => {
    it("stops delivering events after unsubscribe", async () => {
      const bus = new EventBus();
      const received: RuntimeEventRecord[] = [];

      const unsub = bus.subscribe((ev) => received.push(ev));
      bus.emit(makeEvent("before-unsub"), makeCtx());
      await Promise.resolve();

      unsub();
      bus.emit(makeEvent("after-unsub"), makeCtx());
      await Promise.resolve();

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("before-unsub");
    });
  });

  describe("single queueMicrotask per emission cycle", () => {
    it("only schedules one microtask for multiple emits in the same tick", () => {
      const bus = new EventBus();
      const spy = vi.spyOn(globalThis, "queueMicrotask");

      bus.subscribe(() => {});

      bus.emit(makeEvent("a"), makeCtx());
      bus.emit(makeEvent("b"), makeCtx());
      bus.emit(makeEvent("c"), makeCtx());

      // Only one queueMicrotask call despite 3 emits
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
});
