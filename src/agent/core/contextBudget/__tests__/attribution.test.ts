import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { appendAttributionLog, buildAttributionEntry } from "../attribution";
import type { AttributionLogEntry, BanditState } from "../types";
import { emptyBanditState } from "../types";

/** Arbitrary for a valid AttributionLogEntry. */
const arbLogEntry: fc.Arbitrary<AttributionLogEntry> = fc.record({
  timestamp: fc.nat(),
  pulledArms: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
  filesPerArm: fc.constant({}),
  reward: fc.double({ min: 0, max: 1, noNaN: true }),
});

describe("Feature: adaptive-context-budget", () => {
  describe("Property 10: Attribution log FIFO cap invariant", () => {
    it("For any sequence of appendAttributionLog calls with cap N, the log never exceeds N entries. Oldest evicted first, newest at end.", () => {
      fc.assert(
        fc.property(
          fc.array(arbLogEntry, { minLength: 1, maxLength: 50 }),
          fc.integer({ min: 1, max: 20 }),
          (entries, cap) => {
            let state: BanditState = emptyBanditState();

            for (const entry of entries) {
              state = appendAttributionLog(state, entry, cap);

              // Log never exceeds cap
              expect(state.log.length).toBeLessThanOrEqual(cap);
            }

            // After all appends, newest entry is at the end
            if (entries.length > 0) {
              const lastEntry = entries[entries.length - 1];
              expect(state.log[state.log.length - 1]).toEqual(lastEntry);
            }

            // If more entries than cap, oldest should have been evicted
            if (entries.length > cap) {
              // The log should contain the last `cap` entries in order
              const expectedEntries = entries.slice(entries.length - cap);
              expect(state.log).toEqual(expectedEntries);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 6.1, 6.2, 6.3
     */
  });
});
