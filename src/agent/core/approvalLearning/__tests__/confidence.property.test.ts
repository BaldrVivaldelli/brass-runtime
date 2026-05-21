// src/agent/core/approvalLearning/__tests__/confidence.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { decayWeight, computeConfidence, shouldAutoApprove } from "../confidence";
import { DEFAULT_LEARNING_CONFIG } from "../types";
import type { ApprovalObservation, LearningConfig } from "../types";

// --- Generators ---

const observationArb: fc.Arbitrary<ApprovalObservation> = fc.record({
  approved: fc.boolean(),
  timestamp: fc.nat(),
});

const observationsArb = fc.array(observationArb, { minLength: 0, maxLength: 100 });

const decayFactorArb = fc.double({ min: 0.01, max: 0.99, noNaN: true });

const windowArb = fc.integer({ min: 1, max: 200 });

// --- Property 1: Confidence score bounds ---

describe("Property 1: Confidence score bounds", () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * For any observation history array and valid decay factor in (0, 1),
   * computeConfidence SHALL return a value in [0, 1] inclusive.
   */
  it("computeConfidence always returns a value in [0, 1]", () => {
    fc.assert(
      fc.property(
        observationsArb,
        decayFactorArb,
        windowArb,
        (observations, decayFactor, observationWindow) => {
          const confidence = computeConfidence(observations, { decayFactor, observationWindow });
          expect(confidence).toBeGreaterThanOrEqual(0);
          expect(confidence).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 2: Decay weight monotonicity ---

describe("Property 2: Decay weight monotonicity", () => {
  /**
   * **Validates: Requirements 1.2, 4.1**
   *
   * For any two positions p1 < p2 and valid decay factor in (0, 1),
   * decayWeight(p1, d) > decayWeight(p2, d) (more recent = higher weight).
   */
  it("more recent positions have strictly higher weight", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        decayFactorArb,
        (p1, decayFactor) => {
          const p2 = p1 + 1;
          const w1 = decayWeight(p1, decayFactor);
          const w2 = decayWeight(p2, decayFactor);
          expect(w1).toBeGreaterThan(w2);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 8: Concept drift adaptation ---

describe("Property 8: Concept drift adaptation", () => {
  /**
   * **Validates: Requirements 4.2**
   *
   * Generate a full window of approvals, then append consecutive rejections;
   * verify confidence monotonically decreases and drops below threshold
   * within observationWindow rejections.
   */
  it("consecutive rejections cause confidence to monotonically decrease and drop below threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        decayFactorArb,
        fc.double({ min: 0.5, max: 0.99, noNaN: true }),
        (windowSize, decayFactor, threshold) => {
          const config: LearningConfig = {
            confidenceThreshold: threshold,
            observationWindow: windowSize,
            decayFactor,
            minSampleSize: 1,
          };

          // Start with a full window of approvals
          const baseObservations: ApprovalObservation[] = Array.from(
            { length: windowSize },
            (_, i) => ({ approved: true, timestamp: i }),
          );

          let prevConfidence = computeConfidence(baseObservations, config);
          let droppedBelowThreshold = prevConfidence <= threshold;

          // Append rejections one at a time
          const observations = [...baseObservations];
          for (let i = 0; i < windowSize; i++) {
            observations.push({ approved: false, timestamp: windowSize + i });
            const confidence = computeConfidence(observations, config);

            // Monotonically decreasing
            expect(confidence).toBeLessThanOrEqual(prevConfidence);
            prevConfidence = confidence;

            if (confidence <= threshold) {
              droppedBelowThreshold = true;
              break;
            }
          }

          // Must drop below threshold within observationWindow rejections
          expect(droppedBelowThreshold).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 10: Configurable parameters affect computation ---

describe("Property 10: Configurable parameters affect computation", () => {
  /**
   * **Validates: Requirements 2.4, 9.2, 9.3**
   *
   * For a fixed non-uniform observation history:
   * - Changing decayFactor produces different confidence
   * - Changing window produces different confidence when history exceeds smaller window
   * - Changing threshold changes auto-approval decision near boundary
   */
  it("changing decayFactor produces different confidence for non-uniform history", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 0.49, noNaN: true }),
        fc.double({ min: 0.51, max: 0.99, noNaN: true }),
        (d1, d2) => {
          // Non-uniform history: mix of approvals and rejections
          const observations: ApprovalObservation[] = [
            { approved: true, timestamp: 1 },
            { approved: false, timestamp: 2 },
            { approved: true, timestamp: 3 },
            { approved: true, timestamp: 4 },
            { approved: false, timestamp: 5 },
          ];

          const c1 = computeConfidence(observations, { decayFactor: d1, observationWindow: 50 });
          const c2 = computeConfidence(observations, { decayFactor: d2, observationWindow: 50 });

          expect(c1).not.toBeCloseTo(c2, 5);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("changing window produces different confidence when history exceeds smaller window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 6, max: 20 }),
        fc.double({ min: 0.3, max: 0.99, noNaN: true }),
        (smallWindow, largeWindow, decayFactor) => {
          // Build history where the first portion (only visible to large window)
          // is all-rejected, and the last portion (visible to both) is all-approved.
          // This guarantees the large window sees rejections that the small window doesn't.
          const observations: ApprovalObservation[] = [
            // Rejections at the start (only large window sees these)
            ...Array.from({ length: largeWindow - smallWindow }, (_, i) => ({
              approved: false,
              timestamp: i,
            })),
            // Approvals at the end (both windows see these)
            ...Array.from({ length: smallWindow }, (_, i) => ({
              approved: true,
              timestamp: largeWindow - smallWindow + i,
            })),
          ];

          const c1 = computeConfidence(observations, { decayFactor, observationWindow: smallWindow });
          const c2 = computeConfidence(observations, { decayFactor, observationWindow: largeWindow });

          // Small window sees only approvals → confidence = 1.0
          // Large window sees rejections + approvals → confidence < 1.0
          expect(c1).toBeGreaterThan(c2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("changing threshold changes auto-approval decision near boundary", () => {
    fc.assert(
      fc.property(
        decayFactorArb,
        (decayFactor) => {
          // All-approved history → confidence = 1.0
          const observations: ApprovalObservation[] = Array.from(
            { length: 10 },
            (_, i) => ({ approved: true, timestamp: i }),
          );

          const lowThreshold: LearningConfig = {
            confidenceThreshold: 0.5,
            observationWindow: 50,
            decayFactor,
            minSampleSize: 5,
          };

          const highThreshold: LearningConfig = {
            confidenceThreshold: 1.0, // impossible to exceed
            observationWindow: 50,
            decayFactor,
            minSampleSize: 5,
          };

          // Low threshold → auto-approve, high threshold → delegate
          expect(shouldAutoApprove(observations, lowThreshold)).toBe(true);
          expect(shouldAutoApprove(observations, highThreshold)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
