// src/agent/core/approvalLearning/__tests__/store.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { addObservation } from "../store";
import { computeConfidence } from "../confidence";
import { emptyApprovalHistory } from "../types";
import type { ApprovalObservation, ApprovalHistory } from "../types";

// --- Generators ---

const observationArb: fc.Arbitrary<ApprovalObservation> = fc.record({
  approved: fc.boolean(),
  timestamp: fc.nat(),
});

const actionTypeArb = fc.string({ minLength: 1, maxLength: 10 });

// --- Property 3: Window size invariant ---

describe("Property 3: Window size invariant", () => {
  /**
   * **Validates: Requirements 1.3, 3.3**
   *
   * For any sequence of addObservation calls, stored observations
   * never exceed the configured window size; oldest discarded first.
   */
  it("observations never exceed window size after any sequence of additions", () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { minLength: 1, maxLength: 100 }),
        fc.integer({ min: 1, max: 50 }),
        actionTypeArb,
        (observations, windowSize, actionType) => {
          let history: ApprovalHistory = emptyApprovalHistory();

          for (const obs of observations) {
            history = addObservation(history, actionType, obs, windowSize);
            const stored = history.actions[actionType]?.observations ?? [];
            expect(stored.length).toBeLessThanOrEqual(windowSize);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("oldest observations are discarded first when window is exceeded", () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { minLength: 2, maxLength: 50 }),
        fc.integer({ min: 1, max: 10 }),
        actionTypeArb,
        (observations, windowSize, actionType) => {
          let history: ApprovalHistory = emptyApprovalHistory();

          for (const obs of observations) {
            history = addObservation(history, actionType, obs, windowSize);
          }

          const stored = history.actions[actionType]?.observations ?? [];
          const expectedCount = Math.min(observations.length, windowSize);
          expect(stored.length).toBe(expectedCount);

          // The stored observations should be the last `windowSize` from the input
          const expectedObs = observations.slice(-windowSize);
          expect(stored).toEqual(expectedObs);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 7: Action type isolation ---

describe("Property 7: Action type isolation", () => {
  /**
   * **Validates: Requirements 10.1, 10.3**
   *
   * Recording observations for type A does not change confidence for type B.
   */
  it("recording for one action type does not affect another", () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { minLength: 1, maxLength: 20 }),
        fc.array(observationArb, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 5, max: 50 }),
        fc.double({ min: 0.1, max: 0.99, noNaN: true }),
        (obsA, obsB, windowSize, decayFactor) => {
          const typeA = "fs.readFile";
          const typeB = "shell.exec";

          // Build history with type B observations
          let history: ApprovalHistory = emptyApprovalHistory();
          for (const obs of obsB) {
            history = addObservation(history, typeB, obs, windowSize);
          }

          // Compute confidence for type B before adding type A observations
          const storedB = history.actions[typeB]?.observations ?? [];
          const confidenceBefore = computeConfidence(storedB, { decayFactor, observationWindow: windowSize });

          // Add observations for type A
          for (const obs of obsA) {
            history = addObservation(history, typeA, obs, windowSize);
          }

          // Confidence for type B should be unchanged
          const storedBAfter = history.actions[typeB]?.observations ?? [];
          const confidenceAfter = computeConfidence(storedBAfter, { decayFactor, observationWindow: windowSize });

          expect(confidenceAfter).toBe(confidenceBefore);
        },
      ),
      { numRuns: 200 },
    );
  });
});
