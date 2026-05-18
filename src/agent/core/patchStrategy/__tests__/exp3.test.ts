import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { exp3Probabilities, exp3Update, initialEXP3State } from "../exp3";
import type { PatchStrategy, EXP3State } from "../types";
import { PATCH_STRATEGIES } from "../types";

/**
 * Property-based tests for EXP3 algorithm.
 * Feature: adaptive-patch-strategy
 */

/** Arbitrary for a valid PatchStrategy. */
const arbPatchStrategy: fc.Arbitrary<PatchStrategy> = fc.constantFrom(...PATCH_STRATEGIES);

/** Arbitrary for a reward value in [0, 1]. */
const arbReward = fc.double({ min: 0, max: 1, noNaN: true });

/** Arbitrary for gamma in (0, 1]. */
const arbGamma = fc.double({ min: 0.01, max: 1, noNaN: true });

/** Arbitrary for a valid EXP3State with positive weights and gamma in (0, 1]. */
const arbEXP3State: fc.Arbitrary<EXP3State> = fc.record({
    algorithm: fc.constant("exp3" as const),
    arms: fc.record({
        "direct-patch": fc.record({
            weight: fc.double({ min: 0.001, max: 1e50, noNaN: true }),
        }),
        "multi-step-patch": fc.record({
            weight: fc.double({ min: 0.001, max: 1e50, noNaN: true }),
        }),
        "propose-then-refine": fc.record({
            weight: fc.double({ min: 0.001, max: 1e50, noNaN: true }),
        }),
    }),
    gamma: arbGamma,
    totalRounds: fc.nat({ max: 1000 }),
});

describe("exp3 property tests", () => {
    /**
     * Property 6: EXP3 probability distribution validity
     *
     * For any valid EXP3State (positive weights, gamma in (0,1]),
     * exp3Probabilities returns a distribution where all probs are non-negative,
     * each >= gamma/3, and sum equals 1.0 (±1e-10).
     *
     * Feature: adaptive-patch-strategy, Property 6: EXP3 probability distribution validity
     * **Validates: Requirements 4.2, 4.3, 10.2**
     */
    describe("Property 6: EXP3 probability distribution validity", () => {
        it("probabilities are non-negative, each >= gamma/K, and sum to 1.0", () => {
            fc.assert(
                fc.property(arbEXP3State, (state) => {
                    const probs = exp3Probabilities(state);
                    const K = 3;

                    let sum = 0;
                    for (const arm of PATCH_STRATEGIES) {
                        const p = probs[arm];
                        // Non-negative
                        expect(p).toBeGreaterThanOrEqual(0);
                        // Each probability is at least gamma/K (the uniform floor)
                        expect(p).toBeGreaterThanOrEqual(state.gamma / K - 1e-10);
                        sum += p;
                    }

                    // Sum equals 1.0 within tolerance
                    expect(Math.abs(sum - 1.0)).toBeLessThanOrEqual(1e-10);
                }),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 7: EXP3 weight update correctness
     *
     * For any valid EXP3State, selected arm, and reward in [0,1], after exp3Update,
     * the selected arm's weight is old_weight * exp(gamma * (reward/probability) / K)
     * (within tolerance), other arms unchanged.
     *
     * Feature: adaptive-patch-strategy, Property 7: EXP3 weight update correctness
     * **Validates: Requirements 4.4**
     */
    describe("Property 7: EXP3 weight update correctness", () => {
        it("updates selected arm weight correctly and leaves others unchanged", () => {
            fc.assert(
                fc.property(arbEXP3State, arbPatchStrategy, arbReward, (state, arm, reward) => {
                    const K = 3;
                    const probs = exp3Probabilities(state);
                    const pSelected = probs[arm];
                    const oldWeight = state.arms[arm].weight;

                    const updated = exp3Update(state, arm, reward);

                    // Expected new weight (clamped to 1e100)
                    const estimatedReward = reward / pSelected;
                    const expectedWeight = Math.min(
                        oldWeight * Math.exp((state.gamma * estimatedReward) / K),
                        1e100,
                    );

                    // Within floating-point tolerance
                    expect(updated.arms[arm].weight).toBeCloseTo(expectedWeight, 5);

                    // Other arms unchanged
                    for (const otherArm of PATCH_STRATEGIES) {
                        if (otherArm !== arm) {
                            expect(updated.arms[otherArm].weight).toBe(state.arms[otherArm].weight);
                        }
                    }
                }),
                { numRuns: 100 },
            );
        });
    });
});
