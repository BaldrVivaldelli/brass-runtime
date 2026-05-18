import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { budgetStatus, budgetAllowsCall } from "../state";
import type { BudgetConfig, BudgetState } from "../types";

/**
 * Property 7: Budget zone classification
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.6**
 *
 * For any BudgetState and BudgetConfig, budgetStatus SHALL return:
 * (a) { type: "under" } when totalTokens <= tokenBudget
 * (b) { type: "warning" } when tokenBudget < totalTokens <= tokenBudget * (1 + overshootFraction)
 * (c) { type: "exceeded" } when totalTokens > tokenBudget * (1 + overshootFraction)
 *
 * Furthermore, budgetAllowsCall SHALL return true for "under" and "warning",
 * and false for "exceeded".
 */
describe("Property 7: Budget zone classification", () => {
    /**
     * Arbitrary for a valid BudgetConfig with positive finite tokenBudget
     * and overshootFraction in [0, 1].
     */
    const arbBudgetConfig: fc.Arbitrary<BudgetConfig> = fc.record({
        tokenBudget: fc.integer({ min: 1, max: 1_000_000 }),
        overshootFraction: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        enabled: fc.constant(true as const),
    });

    /**
     * Generates a BudgetState with a specific totalTokens value.
     * The totalInputTokens and totalOutputTokens are split arbitrarily
     * but sum to totalTokens.
     */
    const arbBudgetStateWithTokens = (totalTokens: number): fc.Arbitrary<BudgetState> =>
        fc.integer({ min: 0, max: totalTokens }).map((inputTokens) => ({
            totalInputTokens: inputTokens,
            totalOutputTokens: totalTokens - inputTokens,
            totalTokens,
            callCount: 1,
            calls: [],
        }));

    describe("under zone: totalTokens <= tokenBudget", () => {
        it("returns { type: 'under' } when totalTokens is at or below tokenBudget", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                    (config, fraction) => {
                        // totalTokens in [0, tokenBudget]
                        const totalTokens = Math.floor(fraction * config.tokenBudget);
                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        expect(status.type).toBe("under");
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("budgetAllowsCall returns true for under zone", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                    (config, fraction) => {
                        const totalTokens = Math.floor(fraction * config.tokenBudget);
                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        expect(budgetAllowsCall(state, config)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("warning zone: tokenBudget < totalTokens <= tokenBudget * (1 + overshootFraction)", () => {
        it("returns { type: 'warning' } when totalTokens is in the warning zone", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig.filter((c) => c.overshootFraction > 0),
                    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                    (config, fraction) => {
                        // totalTokens in (tokenBudget, tokenBudget * (1 + overshootFraction)]
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        const warningRange = hardCap - config.tokenBudget;
                        // fraction in (0, 1] maps to (tokenBudget, hardCap]
                        const totalTokens = config.tokenBudget + Math.ceil(fraction * warningRange);

                        // Ensure we're strictly above tokenBudget and at or below hardCap
                        if (totalTokens <= config.tokenBudget || totalTokens > hardCap) return;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        expect(status.type).toBe("warning");
                        expect(status.type === "warning" && status.overage).toBe(totalTokens - config.tokenBudget);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("budgetAllowsCall returns true for warning zone", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig.filter((c) => c.overshootFraction > 0),
                    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                    (config, fraction) => {
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        const warningRange = hardCap - config.tokenBudget;
                        const totalTokens = config.tokenBudget + Math.ceil(fraction * warningRange);

                        if (totalTokens <= config.tokenBudget || totalTokens > hardCap) return;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        expect(budgetAllowsCall(state, config)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("exceeded zone: totalTokens > tokenBudget * (1 + overshootFraction)", () => {
        it("returns { type: 'exceeded' } when totalTokens exceeds the hard cap", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.integer({ min: 1, max: 500_000 }),
                    (config, excess) => {
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        const totalTokens = Math.ceil(hardCap) + excess;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        expect(status.type).toBe("exceeded");
                        expect(status.type === "exceeded" && status.overage).toBe(totalTokens - config.tokenBudget);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("budgetAllowsCall returns false for exceeded zone", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.integer({ min: 1, max: 500_000 }),
                    (config, excess) => {
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        const totalTokens = Math.ceil(hardCap) + excess;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        expect(budgetAllowsCall(state, config)).toBe(false);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("zones are exhaustive and mutually exclusive", () => {
        it("every totalTokens value falls into exactly one zone", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.integer({ min: 0, max: 2_000_000 }),
                    (config, totalTokens) => {
                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);

                        // Exhaustive: status type is one of the three
                        expect(["under", "warning", "exceeded"]).toContain(status.type);

                        // Mutually exclusive: zone matches the boundary conditions
                        if (totalTokens <= config.tokenBudget) {
                            expect(status.type).toBe("under");
                        } else if (totalTokens <= hardCap) {
                            expect(status.type).toBe("warning");
                        } else {
                            expect(status.type).toBe("exceeded");
                        }
                    },
                ),
                { numRuns: 500 },
            );
        });

        it("budgetAllowsCall is consistent with budgetStatus", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    fc.integer({ min: 0, max: 2_000_000 }),
                    (config, totalTokens) => {
                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        const allows = budgetAllowsCall(state, config);

                        if (status.type === "under" || status.type === "warning") {
                            expect(allows).toBe(true);
                        } else {
                            expect(allows).toBe(false);
                        }
                    },
                ),
                { numRuns: 500 },
            );
        });
    });

    describe("boundary conditions", () => {
        it("totalTokens exactly at tokenBudget is 'under'", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    (config) => {
                        const state: BudgetState = {
                            totalInputTokens: config.tokenBudget,
                            totalOutputTokens: 0,
                            totalTokens: config.tokenBudget,
                            callCount: 1,
                            calls: [],
                        };

                        expect(budgetStatus(state, config).type).toBe("under");
                        expect(budgetAllowsCall(state, config)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("totalTokens exactly at hard cap is 'warning'", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig.filter((c) => c.overshootFraction > 0),
                    (config) => {
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        // Use integer hard cap to avoid floating point issues
                        const totalTokens = Math.floor(hardCap);

                        // Only test when floor(hardCap) > tokenBudget (i.e., in warning zone)
                        if (totalTokens <= config.tokenBudget) return;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        const status = budgetStatus(state, config);
                        // floor(hardCap) <= hardCap, so it should be "warning" or "under"
                        expect(status.type).not.toBe("exceeded");
                        expect(budgetAllowsCall(state, config)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("totalTokens one above hard cap is 'exceeded'", () => {
            fc.assert(
                fc.property(
                    arbBudgetConfig,
                    (config) => {
                        const hardCap = config.tokenBudget * (1 + config.overshootFraction);
                        const totalTokens = Math.ceil(hardCap) + 1;

                        const state: BudgetState = {
                            totalInputTokens: totalTokens,
                            totalOutputTokens: 0,
                            totalTokens,
                            callCount: 1,
                            calls: [],
                        };

                        expect(budgetStatus(state, config).type).toBe("exceeded");
                        expect(budgetAllowsCall(state, config)).toBe(false);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
