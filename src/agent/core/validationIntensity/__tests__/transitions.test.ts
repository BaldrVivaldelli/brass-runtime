import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeNextIntensity, updateCommandStats } from "../transitions";
import type { CommandStats, IntensityLevel, TransitionInput } from "../types";

/**
 * Property-based tests for intensity transitions.
 * Feature: adaptive-validation-intensity
 */
describe("Intensity transitions property tests", () => {
    /** Arbitrary for IntensityLevel */
    const arbIntensityLevel: fc.Arbitrary<IntensityLevel> = fc.constantFrom(
        "full" as const,
        "reduced" as const,
        "skip" as const,
    );

    /** Arbitrary for outcome */
    const arbOutcome: fc.Arbitrary<"pass" | "fail"> = fc.constantFrom(
        "pass" as const,
        "fail" as const,
    );

    /** Arbitrary for non-negative consecutive pass count */
    const arbPassCount = fc.nat({ max: 100 });

    /** Arbitrary for CommandStats with failures <= totalRuns */
    const arbCommandStats: fc.Arbitrary<CommandStats> = fc
        .record({
            totalRuns: fc.nat({ max: 1000 }),
            failures: fc.nat({ max: 1000 }),
            avgTimeToFailureMs: fc.nat({ max: 60000 }),
        })
        .filter((s) => s.failures <= s.totalRuns);

    /**
     * Property 5: Failure always escalates to full
     *
     * For any IntensityLevel and any consecutivePassCount (≥ 0), when outcome
     * is "fail", computeNextIntensity SHALL return
     * { nextLevel: "full", consecutivePassCount: 0 }.
     *
     * **Validates: Requirements 2.3, 8.5**
     */
    describe("Property 5: Failure always escalates to full", () => {
        it("any failure outcome always produces nextLevel 'full' with consecutivePassCount 0", () => {
            fc.assert(
                fc.property(
                    arbIntensityLevel,
                    arbPassCount,
                    (currentLevel, consecutivePassCount) => {
                        const input: TransitionInput = {
                            currentLevel,
                            consecutivePassCount,
                            outcome: "fail",
                        };

                        const result = computeNextIntensity(input);

                        expect(result.nextLevel).toBe("full");
                        expect(result.consecutivePassCount).toBe(0);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 6: Transition output validity
     *
     * For any valid TransitionInput (any IntensityLevel, any non-negative
     * consecutivePassCount, any outcome), computeNextIntensity SHALL return
     * a TransitionOutput where nextLevel is one of "full", "reduced", or "skip",
     * and consecutivePassCount is a non-negative integer.
     *
     * **Validates: Requirements 2.4, 8.2**
     */
    describe("Property 6: Transition output validity", () => {
        it('output nextLevel is always a valid IntensityLevel ("full" | "reduced" | "skip")', () => {
            fc.assert(
                fc.property(
                    arbIntensityLevel,
                    arbPassCount,
                    arbOutcome,
                    (currentLevel, consecutivePassCount, outcome) => {
                        const input: TransitionInput = {
                            currentLevel,
                            consecutivePassCount,
                            outcome,
                        };

                        const result = computeNextIntensity(input);

                        expect(["full", "reduced", "skip"]).toContain(result.nextLevel);
                        expect(result.consecutivePassCount).toBeGreaterThanOrEqual(0);
                        expect(Number.isInteger(result.consecutivePassCount)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 7: Transition thresholds
     *
     * For any TransitionInput where outcome is "pass":
     * (a) if currentLevel is "full" and consecutivePassCount + 1 >= 3,
     *     then nextLevel SHALL be "reduced";
     * (b) if currentLevel is "reduced" and consecutivePassCount + 1 >= 6,
     *     then nextLevel SHALL be "skip".
     *
     * **Validates: Requirements 2.2, 2.5**
     */
    describe("Property 7: Transition thresholds", () => {
        it('"full" + 3 passes → "reduced"', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 2, max: 100 }),
                    (consecutivePassCount) => {
                        // consecutivePassCount + 1 >= 3, so consecutivePassCount >= 2
                        const input: TransitionInput = {
                            currentLevel: "full",
                            consecutivePassCount,
                            outcome: "pass",
                        };

                        const result = computeNextIntensity(input);
                        expect(result.nextLevel).toBe("reduced");
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('"reduced" + 6 passes → "skip"', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 5, max: 100 }),
                    (consecutivePassCount) => {
                        // consecutivePassCount + 1 >= 6, so consecutivePassCount >= 5
                        const input: TransitionInput = {
                            currentLevel: "reduced",
                            consecutivePassCount,
                            outcome: "pass",
                        };

                        const result = computeNextIntensity(input);
                        expect(result.nextLevel).toBe("skip");
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('"full" with fewer than 3 passes stays "full"', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 0, max: 1 }),
                    (consecutivePassCount) => {
                        // consecutivePassCount + 1 < 3, so consecutivePassCount <= 1
                        const input: TransitionInput = {
                            currentLevel: "full",
                            consecutivePassCount,
                            outcome: "pass",
                        };

                        const result = computeNextIntensity(input);
                        expect(result.nextLevel).toBe("full");
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('"reduced" with fewer than 6 passes stays "reduced"', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 0, max: 4 }),
                    (consecutivePassCount) => {
                        // consecutivePassCount + 1 < 6, so consecutivePassCount <= 4
                        const input: TransitionInput = {
                            currentLevel: "reduced",
                            consecutivePassCount,
                            outcome: "pass",
                        };

                        const result = computeNextIntensity(input);
                        expect(result.nextLevel).toBe("reduced");
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 11: Stats update invariants
     *
     * For any CommandStats and any StatsUpdateInput, updateCommandStats SHALL
     * return stats where:
     * (a) totalRuns equals current.totalRuns + 1
     * (b) failures equals current.failures + 1 when exitCode !== 0 and
     *     current.failures otherwise
     * (c) avgTimeToFailureMs is non-negative
     *
     * **Validates: Requirements 4.3**
     */
    describe("Property 11: Stats update invariants", () => {
        it("updateCommandStats always increments totalRuns; failures only increment on non-zero exit", () => {
            fc.assert(
                fc.property(
                    arbCommandStats,
                    fc.integer({ min: -128, max: 128 }),
                    fc.nat({ max: 60000 }),
                    (current, exitCode, durationMs) => {
                        const result = updateCommandStats({ current, exitCode, durationMs });

                        // (a) totalRuns always increments by 1
                        expect(result.totalRuns).toBe(current.totalRuns + 1);

                        // (b) failures increments only on non-zero exit
                        if (exitCode !== 0) {
                            expect(result.failures).toBe(current.failures + 1);
                        } else {
                            expect(result.failures).toBe(current.failures);
                        }

                        // (c) avgTimeToFailureMs is non-negative
                        expect(result.avgTimeToFailureMs).toBeGreaterThanOrEqual(0);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
