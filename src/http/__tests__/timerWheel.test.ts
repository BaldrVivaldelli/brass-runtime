import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { TimerWheel } from "../timerWheel";

/**
 * Property-based tests for TimerWheel destroy behavior.
 * Feature: http-p99-optimization
 */
describe("TimerWheel property tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Property P8: Timer wheel destroy releases all
   *
   * For any set of N scheduled timers, calling destroy() SHALL cancel all
   * pending entries without invoking their expiry callbacks, clear any active
   * setTimeout handle, and release all references to registered callbacks so
   * they become eligible for garbage collection. After destroy(), advancing
   * time should not fire any callbacks and pending count should be 0.
   *
   * **Validates: Requirement 1.7**
   */
  describe("Property P8: Timer wheel destroy releases all", () => {
    it("destroy cancels all pending entries without firing callbacks", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.integer({ min: 10, max: 5000 }),
            { minLength: 1, maxLength: 100 },
          ),
          (timeouts) => {
            const wheel = new TimerWheel({ tickMs: 10, slots: 512 });
            let callbacksFired = 0;

            // Schedule N timers
            for (const timeoutMs of timeouts) {
              wheel.schedule(timeoutMs, () => {
                callbacksFired++;
              });
            }

            // Destroy the wheel
            wheel.destroy();

            // Advance time well beyond the maximum timeout
            const maxTimeout = Math.max(...timeouts);
            vi.advanceTimersByTime(maxTimeout + 1000);

            // Assert: no callbacks should have fired
            expect(callbacksFired).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("destroy results in pending count of 0", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.integer({ min: 10, max: 5000 }),
            { minLength: 1, maxLength: 100 },
          ),
          (timeouts) => {
            const wheel = new TimerWheel({ tickMs: 10, slots: 512 });

            // Schedule N timers
            for (const timeoutMs of timeouts) {
              wheel.schedule(timeoutMs, () => {});
            }

            // Destroy the wheel
            wheel.destroy();

            // Access pending via scheduling a new timer and checking behavior
            // Since pending is private, we verify indirectly: after destroy,
            // advancing time fires nothing and no setTimeout is active
            vi.advanceTimersByTime(10000);

            // If pending were > 0, the wheel would try to tick and potentially
            // throw or fire callbacks. The fact that nothing happens confirms
            // pending is effectively 0.
            // We also verify by checking that no timers are pending in the fake timer system
            expect(vi.getTimerCount()).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("destroy clears the active setTimeout handle", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.integer({ min: 10, max: 5000 }),
            { minLength: 1, maxLength: 50 },
          ),
          (timeouts) => {
            const wheel = new TimerWheel({ tickMs: 10, slots: 512 });

            // Schedule N timers — this should start the internal setTimeout
            for (const timeoutMs of timeouts) {
              wheel.schedule(timeoutMs, () => {});
            }

            // Before destroy, there should be at least one active timer
            expect(vi.getTimerCount()).toBeGreaterThan(0);

            // Destroy the wheel
            wheel.destroy();

            // After destroy, no active setTimeout handles should remain
            expect(vi.getTimerCount()).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("destroy after partial expiry still cancels remaining entries", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }),
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 200, max: 2000 }),
          (count, shortTimeout, longTimeout) => {
            const wheel = new TimerWheel({ tickMs: 10, slots: 512 });
            let earlyFired = 0;
            let lateFired = 0;

            // Schedule some short timers and some long timers
            const halfCount = Math.max(1, Math.floor(count / 2));

            for (let i = 0; i < halfCount; i++) {
              wheel.schedule(shortTimeout, () => {
                earlyFired++;
              });
            }

            for (let i = 0; i < halfCount; i++) {
              wheel.schedule(longTimeout, () => {
                lateFired++;
              });
            }

            // Advance time to fire the short timers
            vi.advanceTimersByTime(shortTimeout + 20);
            const firedBeforeDestroy = earlyFired;

            // Destroy the wheel — remaining long timers should not fire
            wheel.destroy();

            // Advance time well beyond the long timeout
            vi.advanceTimersByTime(longTimeout + 1000);

            // Late callbacks should never have fired
            expect(lateFired).toBe(0);
            // No additional early callbacks should have fired after destroy
            expect(earlyFired).toBe(firedBeforeDestroy);
            // No active timers remain
            expect(vi.getTimerCount()).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("destroy is idempotent — calling it multiple times has no adverse effect", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.integer({ min: 10, max: 5000 }),
            { minLength: 1, maxLength: 50 },
          ),
          fc.integer({ min: 1, max: 5 }),
          (timeouts, destroyCalls) => {
            const wheel = new TimerWheel({ tickMs: 10, slots: 512 });
            let callbacksFired = 0;

            for (const timeoutMs of timeouts) {
              wheel.schedule(timeoutMs, () => {
                callbacksFired++;
              });
            }

            // Call destroy multiple times
            for (let i = 0; i < destroyCalls; i++) {
              wheel.destroy();
            }

            // Advance time
            const maxTimeout = Math.max(...timeouts);
            vi.advanceTimersByTime(maxTimeout + 1000);

            expect(callbacksFired).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

/**
 * Unit tests for TimerWheel zero-idle-cost invariant.
 * Feature: http-p99-optimization
 */
describe("TimerWheel unit tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * P3: Zero pending → no active setTimeout
   *
   * WHEN no timeouts are pending, THE Timer_Wheel SHALL hold zero active
   * setTimeout handles (no background timer scheduled), consuming no
   * event-loop resources until a new timeout is registered.
   *
   * **Validates: Requirement 1.5**
   */
  describe("P3: Zero pending → no active setTimeout", () => {
    it("schedule then cancel → internal timer field is undefined", () => {
      const wheel = new TimerWheel({ tickMs: 10, slots: 64 });

      // Before scheduling, timer should be undefined
      expect((wheel as any).timer).toBeUndefined();

      // Schedule a timer — ensureTimer() should create a setTimeout
      const handle = wheel.schedule(100, () => {});
      expect((wheel as any).timer).toBeDefined();

      // Cancel the timer — maybeStopTimer() should clear the setTimeout
      handle.cancel();
      expect((wheel as any).timer).toBeUndefined();

      wheel.destroy();
    });

    it("schedule multiple, cancel all → internal timer field is undefined", () => {
      const wheel = new TimerWheel({ tickMs: 10, slots: 64 });

      const h1 = wheel.schedule(50, () => {});
      const h2 = wheel.schedule(100, () => {});
      const h3 = wheel.schedule(200, () => {});

      expect((wheel as any).timer).toBeDefined();

      h1.cancel();
      // Still have pending timers, timer should remain active
      expect((wheel as any).timer).toBeDefined();

      h2.cancel();
      // Still have one pending timer
      expect((wheel as any).timer).toBeDefined();

      h3.cancel();
      // All cancelled — timer should be cleared
      expect((wheel as any).timer).toBeUndefined();

      wheel.destroy();
    });

    it("timer becomes defined again when new entry is scheduled after reaching zero", () => {
      const wheel = new TimerWheel({ tickMs: 10, slots: 64 });

      const h1 = wheel.schedule(50, () => {});
      h1.cancel();
      expect((wheel as any).timer).toBeUndefined();

      // Schedule again — should re-activate the background timer
      const h2 = wheel.schedule(100, () => {});
      expect((wheel as any).timer).toBeDefined();

      h2.cancel();
      expect((wheel as any).timer).toBeUndefined();

      wheel.destroy();
    });
  });
});
