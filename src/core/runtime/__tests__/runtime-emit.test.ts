// src/core/runtime/__tests__/runtime-emit.test.ts
import { describe, it, expect } from "vitest";
import { Runtime, NoopHooks } from "../runtime";
import { EventBus } from "../eventBus";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeEventRecord } from "../events";
import { async, asyncSucceed, unit } from "../../types/asyncEffect";
import { withScope, withScopeAsync } from "../scope";

/**
 * Verification tests for Runtime.emit() conditional emission (Task 4.1.3).
 *
 * Validates that the fast-path optimization (`if (this.hooks === NoopHooks) return`)
 * does NOT interfere with event delivery when hooks ARE active (i.e. an EventBus).
 */

/** Helper: collect all events from an EventBus into an array. */
function collectEvents(bus: EventBus): RuntimeEventRecord[] {
  const events: RuntimeEventRecord[] = [];
  bus.subscribe((ev) => events.push(ev));
  return events;
}

/** Helper: create a Runtime with an active EventBus as hooks. */
function makeRuntimeWithBus(): { rt: Runtime<{}>; bus: EventBus; events: RuntimeEventRecord[] } {
  const bus = new EventBus();
  const events = collectEvents(bus);
  const rt = new Runtime({ env: {}, hooks: bus });
  return { rt, bus, events };
}

/** Helper: flush microtasks + a small setTimeout to let EventBus deliver. */
async function flushEvents(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe("Runtime.emit with active hooks", () => {
  // -----------------------------------------------------------------------
  // 1. Events ARE emitted when hooks are active
  // -----------------------------------------------------------------------
  describe("events are emitted when hooks are active", () => {
    it("emits fiber.start and fiber.end for a simple effect", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(asyncSucceed(42));
      await flushEvents();

      const types = events.map((e) => e.type);
      expect(types).toContain("fiber.start");
      expect(types).toContain("fiber.end");
    });

    it("does NOT emit events when hooks are NoopHooks", async () => {
      const rt = Runtime.make({});
      // NoopHooks is the default — emit should be a no-op
      expect(rt.hooks).toBe(NoopHooks);

      // We can't easily spy on NoopHooks.emit because the fast-path
      // returns before calling it. Instead, verify hasActiveHooks is false.
      expect(rt.hasActiveHooks()).toBe(false);
    });

    it("hasActiveHooks returns true when EventBus is provided", () => {
      const { rt } = makeRuntimeWithBus();
      expect(rt.hasActiveHooks()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. RuntimeEmitContext is properly constructed
  // -----------------------------------------------------------------------
  describe("RuntimeEmitContext construction", () => {
    it("fiber.end event includes fiberId from the fiber's own context", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(asyncSucceed("hello"));
      await flushEvents();

      // fiber.end is emitted from the fiber itself (fiber.emit), which
      // passes { fiberId: this.id } in the context — so fiberId is always set.
      const fiberEnd = events.find((e) => e.type === "fiber.end");
      expect(fiberEnd).toBeDefined();
      expect(fiberEnd!.fiberId).toBeTypeOf("number");
    });

    it("scope.open event is delivered with correct type", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(
        withScope(rt, (_scope) => {
          // scope opens and closes
        })
      );
      await flushEvents();

      // scope.open is emitted via Runtime.emit() and delivered through EventBus.
      // The event record merges the event payload with the RuntimeEmitContext.
      const scopeOpen = events.find((e) => e.type === "scope.open");
      expect(scopeOpen).toBeDefined();
      // Verify the event was delivered with sequence number and timestamps
      expect(scopeOpen!.seq).toBeTypeOf("number");
      expect(scopeOpen!.wallTs).toBeTypeOf("number");
    });
  });

  // -----------------------------------------------------------------------
  // 3. All event types are delivered when hooks are active
  // -----------------------------------------------------------------------
  describe("all event types are delivered", () => {
    it("delivers fiber.start and fiber.end events", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(asyncSucceed("done"));
      await flushEvents();

      const types = events.map((e) => e.type);
      expect(types).toContain("fiber.start");
      expect(types).toContain("fiber.end");
    });

    it("delivers fiber.suspend and fiber.resume events for async effects", async () => {
      const { rt, events } = makeRuntimeWithBus();

      // Create an effect that suspends and then resumes asynchronously
      const eff = async<{}, never, string>((_env, cb) => {
        setTimeout(() => cb({ _tag: "Success", value: "resumed" }), 10);
      });

      await rt.toPromise(eff);
      await flushEvents();

      const types = events.map((e) => e.type);
      expect(types).toContain("fiber.suspend");
      expect(types).toContain("fiber.resume");
    });

    it("delivers scope.open and scope.close events", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(
        withScope(rt, (_scope) => {
          // scope opens and closes
        })
      );
      await flushEvents();

      const types = events.map((e) => e.type);
      expect(types).toContain("scope.open");
      expect(types).toContain("scope.close");
    });

    it("delivers log events via Runtime.log()", async () => {
      const { rt, bus, events } = makeRuntimeWithBus();

      // We need to emit a log event from within a running fiber so the
      // EventBus receives it. Use a Sync effect to call rt.log inside a fiber.
      await rt.toPromise(
        async<{}, never, void>((_env, cb) => {
          rt.log("info", "test-message", { key: "value" });
          cb({ _tag: "Success", value: undefined });
        })
      );
      await flushEvents();

      const logEvents = events.filter((e) => e.type === "log" && e.message === "test-message");
      expect(logEvents.length).toBeGreaterThanOrEqual(1);
      expect(logEvents[0].level).toBe("info");
      expect(logEvents[0].fields).toEqual({ key: "value" });
    });
  });

  // -----------------------------------------------------------------------
  // 4. Fast-path does NOT interfere with event delivery
  // -----------------------------------------------------------------------
  describe("fast-path does not interfere with active hooks", () => {
    it("a NoopHooks runtime skips emit while an EventBus runtime delivers", async () => {
      // NoopHooks runtime — no events
      const noopRt = Runtime.make({});
      expect(noopRt.hasActiveHooks()).toBe(false);

      // EventBus runtime — events delivered
      const { rt: activeRt, events } = makeRuntimeWithBus();
      expect(activeRt.hasActiveHooks()).toBe(true);

      await activeRt.toPromise(asyncSucceed(1));
      await flushEvents();

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "fiber.start")).toBe(true);
    });

    it("fiber.end status is correct for successful effects", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(asyncSucceed("ok"));
      await flushEvents();

      const fiberEnd = events.find((e) => e.type === "fiber.end");
      expect(fiberEnd).toBeDefined();
      expect((fiberEnd as any).status).toBe("success");
    });

    it("fiber.end status is correct for failed effects", async () => {
      const { rt, events } = makeRuntimeWithBus();

      try {
        await rt.toPromise(
          async<{}, string, never>((_env, cb) => {
            cb({ _tag: "Failure", cause: { _tag: "Fail", error: "boom" } });
          })
        );
      } catch {
        // expected
      }
      await flushEvents();

      const fiberEnd = events.find((e) => e.type === "fiber.end");
      expect(fiberEnd).toBeDefined();
      expect((fiberEnd as any).status).toBe("failure");
    });

    it("scope.close status reflects the exit of the scope body", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(
        withScopeAsync(rt, (_scope) => {
          return asyncSucceed(undefined) as any;
        })
      );
      await flushEvents();

      const scopeClose = events.find((e) => e.type === "scope.close");
      expect(scopeClose).toBeDefined();
      expect((scopeClose as any).status).toBe("success");
    });

    it("multiple effects on the same runtime all emit events", async () => {
      const { rt, events } = makeRuntimeWithBus();

      await rt.toPromise(asyncSucceed(1));
      await rt.toPromise(asyncSucceed(2));
      await rt.toPromise(asyncSucceed(3));
      await flushEvents();

      // Each effect should produce at least fiber.start + fiber.end
      const starts = events.filter((e) => e.type === "fiber.start");
      const ends = events.filter((e) => e.type === "fiber.end");
      expect(starts.length).toBe(3);
      expect(ends.length).toBe(3);
    });
  });
});
