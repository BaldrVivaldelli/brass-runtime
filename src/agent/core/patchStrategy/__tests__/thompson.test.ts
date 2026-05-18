import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
    initialThompsonState,
    thompsonSelect,
    thompsonUpdate,
    thompsonStateFromHistory,
} from "../thompson";
import type { PatchStrategy, ThompsonState, RewardEntry } from "../types";
import { PATCH_STRATEGIES } from "../types";

/**
 * Property-based tests for Thompson Sampling.
 * Feature: adaptive-patch-strategy
 */

/** Arbitrary for a valid PatchStrategy. */
const arbPatchStrategy: fc.Arbitrary<PatchStrategy> = fc.constantFrom(...PATCH_STRATEGIES);

/** Arbitrary for a reward value in [0, 1]. */
const arbReward = fc.double({ min: 0, max: 1, noNaN: true });

/** Arbitrary for a RewardEntry. */
const arbRewardEntry: fc.Arbitrary<RewardEntry> = fc.record({
    arm: arbPatchStrategy,
    reward: arbReward,
    timestamp: fc.nat({ max: 2_000_000_000_000 }),
});

/** Arbitrary for a reward history (including empty). */
const arbRewardHistory: fc.Arbitrary<readonly RewardEntry[]> = fc.array(arbRewardEntry, {
    minLength: 0,
    maxLength: 50,
});

/** Arbitrary for a valid ThompsonState (alpha >= 1, beta >= 1 for all arms). */
const arbThompsonState: fc.Arbitrary<ThompsonState> = fc.record({
    algorithm: fc.constant("thompson" as const),
    arms: fc.record({
        "direct-patch": fc.record({
            alpha: fc.double({ min: 1, max: 100, noNaN: true }),
            beta: fc.double({ min: 1, max: 100, noNaN: true }),
        }),
        "multi-step-patch": fc.record({
            alpha: fc.double({ min: 1, max: 100, noNaN: true }),
            beta: fc.double({ min: 1, max: 100, noNaN: true }),
        }),
        "propose-then-refine": fc.record({
            alpha: fc.double({ min: 1, max: 100, noNaN: true }),
            beta: fc.double({ min: 1, max: 100, noNaN: true }),
        }),
    }),
});

describe("thompson property tests", () => {
    /**
     * Property 3: Thompson Sampling Beta parameter invariants
     *
     * For any reward history (including empty), the derived ThompsonState has
     * alpha >= 1 and beta >= 1 for every arm. Arms with no entries have exactly
     * alpha=1, beta=1.
     *
     * Feature: adaptive-patch-strategy, Property 3: Thompson Sampling Beta parameter invariants
     * **Validates: Requirements 3.1, 3.3**
     */
    describe("Property 3: Thompson Sampling Beta parameter invariants", () => {
        it("derived state always has alpha >= 1 and beta >= 1 for all arms", () => {
            fc.assert(
                fc.property(arbRewardHistory, (history) => {
                    const state = thompsonStateFromHistory(history);

                    for (const arm of PATCH_STRATEGIES) {
                        expect(state.arms[arm].alpha).toBeGreaterThanOrEqual(1);
                        expect(state.arms[arm].beta).toBeGreaterThanOrEqual(1);
                    }

                    // Arms with no entries should have exactly alpha=1, beta=1
                    for (const arm of PATCH_STRATEGIES) {
                        const hasEntries = history.some((e) => e.arm === arm);
                        if (!hasEntries) {
                            expect(state.arms[arm].alpha).toBe(1);
                            expect(state.arms[arm].beta).toBe(1);
                        }
                    }
                }),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 4: Thompson Sampling update rule correctness
     *
     * For any valid ThompsonState and reward r in [0,1], after thompsonUpdate(state, arm, r),
     * the updated arm has alpha_new = alpha_old + r and beta_new = beta_old + (1-r),
     * all other arms unchanged.
     *
     * Feature: adaptive-patch-strategy, Property 4: Thompson Sampling update rule correctness
     * **Validates: Requirements 3.4**
     */
    describe("Property 4: Thompson Sampling update rule correctness", () => {
        it("update adds reward to alpha and (1-reward) to beta for selected arm only", () => {
            fc.assert(
                fc.property(arbThompsonState, arbPatchStrategy, arbReward, (state, arm, reward) => {
                    const updated = thompsonUpdate(state, arm, reward);

                    // Updated arm has correct new values
                    const oldArm = state.arms[arm];
                    const expectedAlpha = Math.max(1, oldArm.alpha + reward);
                    const expectedBeta = Math.max(1, oldArm.beta + (1 - reward));
                    expect(updated.arms[arm].alpha).toBeCloseTo(expectedAlpha, 10);
                    expect(updated.arms[arm].beta).toBeCloseTo(expectedBeta, 10);

                    // Other arms remain unchanged
                    for (const otherArm of PATCH_STRATEGIES) {
                        if (otherArm !== arm) {
                            expect(updated.arms[otherArm]).toStrictEqual(state.arms[otherArm]);
                        }
                    }
                }),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 5: Thompson Sampling selects maximum sample
     *
     * For any valid ThompsonState and deterministic RNG that produces known Beta samples,
     * thompsonSelect returns the arm whose sample is maximum.
     *
     * Feature: adaptive-patch-strategy, Property 5: Thompson Sampling selects maximum sample
     * **Validates: Requirements 3.2**
     */
    describe("Property 5: Thompson Sampling selects maximum sample", () => {
        it("selects the arm with the highest Beta sample", () => {
            // Generate 3 distinct sample values for the 3 arms
            const arbSamples = fc.tuple(
                fc.double({ min: 0, max: 1, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
            ).filter(([a, b, c]) => {
                // Ensure there's a unique maximum
                const max = Math.max(a, b, c);
                return [a, b, c].filter((v) => v === max).length === 1;
            });

            fc.assert(
                fc.property(arbThompsonState, arbSamples, (state, samples) => {
                    let callIndex = 0;
                    const rng = {
                        sampleBeta: (_alpha: number, _beta: number): number => {
                            const value = samples[callIndex]!;
                            callIndex++;
                            return value;
                        },
                    };

                    const result = thompsonSelect(state, rng);

                    // Find which arm should have been selected (max sample)
                    const maxSample = Math.max(...samples);
                    const maxIndex = samples.indexOf(maxSample);
                    const expectedArm = PATCH_STRATEGIES[maxIndex];

                    expect(result).toBe(expectedArm);
                }),
                { numRuns: 100 },
            );
        });
    });
});
