// Feature: http-p99-consolidation, Property 6: Timer wheel tickMs clamping
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { TimerWheel } from "../timerWheel";

/**
 * Property 6: Timer wheel tickMs clamping
 *
 * For any numeric value `v` provided as `TimerWheelConfig.tickMs`, the resulting
 * effective tick resolution SHALL be `clamp(v, 1, 16)` — values below 1 become 1,
 * values above 16 become 16, and no error is thrown.
 *
 * **Validates: Requirements 4.5**
 */
describe("Property 6: Timer wheel tickMs clamping", () => {
  function expectedClampedTickMs(v: number): number {
    return Math.max(1, Math.min(16, Math.floor(v)));
  }

  it("clamps arbitrary numeric tickMs values to [1, 16] without throwing", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Negative values
          fc.double({ min: -1e9, max: -0.001, noNaN: true }),
          // Zero
          fc.constant(0),
          // Fractional values in valid range
          fc.double({ min: 0.001, max: 16.999, noNaN: true }),
          // Large positive values
          fc.double({ min: 17, max: 1e9, noNaN: true }),
          // Integer values across full range
          fc.integer({ min: -1000, max: 1000 }),
        ),
        (tickMs) => {
          // No error should be thrown for any input value
          const wheel = new TimerWheel({ tickMs });

          // Access the private tickMs field to verify clamping
          const effectiveTickMs = (wheel as any).tickMs;

          const expected = expectedClampedTickMs(tickMs);
          expect(effectiveTickMs).toBe(expected);

          // Effective tick must always be in [1, 16]
          expect(effectiveTickMs).toBeGreaterThanOrEqual(1);
          expect(effectiveTickMs).toBeLessThanOrEqual(16);

          // Effective tick must always be an integer
          expect(Number.isInteger(effectiveTickMs)).toBe(true);

          wheel.destroy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("clamps negative values to 1", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: -0.001, noNaN: true }),
        (tickMs) => {
          const wheel = new TimerWheel({ tickMs });
          const effectiveTickMs = (wheel as any).tickMs;
          expect(effectiveTickMs).toBe(1);
          wheel.destroy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("clamps values above 16 to 16", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 17, max: 1e9, noNaN: true }),
        (tickMs) => {
          const wheel = new TimerWheel({ tickMs });
          const effectiveTickMs = (wheel as any).tickMs;
          expect(effectiveTickMs).toBe(16);
          wheel.destroy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("floors fractional values within range before clamping", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.001, max: 16.999, noNaN: true }),
        (tickMs) => {
          const wheel = new TimerWheel({ tickMs });
          const effectiveTickMs = (wheel as any).tickMs;
          expect(effectiveTickMs).toBe(Math.floor(tickMs));
          expect(Number.isInteger(effectiveTickMs)).toBe(true);
          wheel.destroy();
        },
      ),
      { numRuns: 100 },
    );
  });
});
