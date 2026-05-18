import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveBudgetConfig, validateBudgetConfig } from "../config";
import type { BudgetConfig, BudgetConfigInput } from "../types";

describe("resolveBudgetConfig", () => {
    it("returns undefined when both inputs are undefined", () => {
        expect(resolveBudgetConfig(undefined, undefined)).toBeUndefined();
    });

    it("returns undefined when neither input provides tokenBudget", () => {
        const goal: BudgetConfigInput = { overshootFraction: 0.2 };
        const config: BudgetConfigInput = { enabled: false };
        expect(resolveBudgetConfig(goal, config)).toBeUndefined();
    });

    it("applies defaults when only tokenBudget is provided via goal", () => {
        const goal: BudgetConfigInput = { tokenBudget: 10000 };
        const result = resolveBudgetConfig(goal, undefined);
        expect(result).toEqual({
            tokenBudget: 10000,
            overshootFraction: 0.10,
            enabled: true,
            modelTiers: undefined,
        });
    });

    it("applies defaults when only tokenBudget is provided via config", () => {
        const config: BudgetConfigInput = { tokenBudget: 5000 };
        const result = resolveBudgetConfig(undefined, config);
        expect(result).toEqual({
            tokenBudget: 5000,
            overshootFraction: 0.10,
            enabled: true,
            modelTiers: undefined,
        });
    });

    it("goal fields override config fields", () => {
        const goal: BudgetConfigInput = { tokenBudget: 20000, overshootFraction: 0.25 };
        const config: BudgetConfigInput = { tokenBudget: 10000, overshootFraction: 0.05, enabled: false };
        const result = resolveBudgetConfig(goal, config);
        expect(result).toEqual({
            tokenBudget: 20000,
            overshootFraction: 0.25,
            enabled: false,
            modelTiers: undefined,
        });
    });

    it("falls back to config fields when goal fields are absent", () => {
        const goal: BudgetConfigInput = { tokenBudget: 15000 };
        const config: BudgetConfigInput = { overshootFraction: 0.3, enabled: false };
        const result = resolveBudgetConfig(goal, config);
        expect(result).toEqual({
            tokenBudget: 15000,
            overshootFraction: 0.3,
            enabled: false,
            modelTiers: undefined,
        });
    });

    it("uses config tokenBudget when goal does not provide one", () => {
        const goal: BudgetConfigInput = { overshootFraction: 0.5 };
        const config: BudgetConfigInput = { tokenBudget: 8000 };
        const result = resolveBudgetConfig(goal, config);
        expect(result).toEqual({
            tokenBudget: 8000,
            overshootFraction: 0.5,
            enabled: true,
            modelTiers: undefined,
        });
    });
});

describe("validateBudgetConfig", () => {
    it("returns undefined for valid config", () => {
        expect(validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: 0.10,
            enabled: true,
        })).toBeUndefined();
    });

    it("rejects zero tokenBudget", () => {
        const result = validateBudgetConfig({
            tokenBudget: 0,
            overshootFraction: 0.10,
            enabled: true,
        });
        expect(result).toContain("tokenBudget");
    });

    it("rejects negative tokenBudget", () => {
        const result = validateBudgetConfig({
            tokenBudget: -100,
            overshootFraction: 0.10,
            enabled: true,
        });
        expect(result).toContain("tokenBudget");
    });

    it("rejects NaN tokenBudget", () => {
        const result = validateBudgetConfig({
            tokenBudget: NaN,
            overshootFraction: 0.10,
            enabled: true,
        });
        expect(result).toContain("tokenBudget");
    });

    it("rejects Infinity tokenBudget", () => {
        const result = validateBudgetConfig({
            tokenBudget: Infinity,
            overshootFraction: 0.10,
            enabled: true,
        });
        expect(result).toContain("tokenBudget");
    });

    it("rejects negative Infinity tokenBudget", () => {
        const result = validateBudgetConfig({
            tokenBudget: -Infinity,
            overshootFraction: 0.10,
            enabled: true,
        });
        expect(result).toContain("tokenBudget");
    });

    it("rejects overshootFraction below 0", () => {
        const result = validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: -0.01,
            enabled: true,
        });
        expect(result).toContain("overshootFraction");
    });

    it("rejects overshootFraction above 1", () => {
        const result = validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: 1.01,
            enabled: true,
        });
        expect(result).toContain("overshootFraction");
    });

    it("accepts overshootFraction of exactly 0", () => {
        expect(validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: 0,
            enabled: true,
        })).toBeUndefined();
    });

    it("accepts overshootFraction of exactly 1", () => {
        expect(validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: 1,
            enabled: true,
        })).toBeUndefined();
    });

    it("rejects NaN overshootFraction", () => {
        const result = validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: NaN,
            enabled: true,
        });
        expect(result).toContain("overshootFraction");
    });

    it("rejects Infinity overshootFraction", () => {
        const result = validateBudgetConfig({
            tokenBudget: 10000,
            overshootFraction: Infinity,
            enabled: true,
        });
        expect(result).toContain("overshootFraction");
    });
});

/**
 * Property 2: Budget config validation rejects invalid inputs
 *
 * **Validates: Requirements 1.5, 1.6**
 *
 * For any number that is not positive and finite (zero, negative, NaN, Infinity)
 * as `tokenBudget`, or any number outside the closed interval [0, 1] as
 * `overshootFraction`, `validateBudgetConfig` SHALL return a non-empty error string.
 * For any positive finite `tokenBudget` and `overshootFraction` in [0, 1],
 * `validateBudgetConfig` SHALL return `undefined`.
 */
describe("Property 2: Budget config validation rejects invalid inputs", () => {
    it("rejects any non-positive tokenBudget", () => {
        fc.assert(
            fc.property(
                fc.double({ max: 0, noNaN: true, noDefaultInfinity: true }),
                fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("rejects NaN tokenBudget", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (overshootFraction, enabled) => {
                    const config: BudgetConfig = { tokenBudget: NaN, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("rejects Infinity and -Infinity tokenBudget", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(Infinity, -Infinity),
                fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("rejects overshootFraction outside [0, 1] (below 0)", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                fc.double({ max: -Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("rejects overshootFraction outside [0, 1] (above 1)", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                fc.double({ min: 1 + Number.EPSILON, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    // Ensure we actually get values > 1 (fc.double min is inclusive)
                    if (overshootFraction <= 1) return;
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("rejects non-finite overshootFraction (NaN, Infinity, -Infinity)", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                fc.constantFrom(NaN, Infinity, -Infinity),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeDefined();
                    expect(typeof result).toBe("string");
                    expect(result!.length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("accepts any positive finite tokenBudget with overshootFraction in [0, 1]", () => {
        fc.assert(
            fc.property(
                fc.double({ min: Number.MIN_VALUE, max: 1e15, noNaN: true, noDefaultInfinity: true }),
                fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
                fc.boolean(),
                (tokenBudget, overshootFraction, enabled) => {
                    // Ensure tokenBudget is actually positive
                    if (tokenBudget <= 0) return;
                    const config: BudgetConfig = { tokenBudget, overshootFraction, enabled };
                    const result = validateBudgetConfig(config);
                    expect(result).toBeUndefined();
                },
            ),
            { numRuns: 200 },
        );
    });
});


/**
 * Property 3: No-budget configuration means no budget behavior
 *
 * **Validates: Requirements 1.2, 8.1**
 *
 * When neither goal nor config provides a `tokenBudget` field,
 * `resolveBudgetConfig` always returns `undefined`.
 */
describe("Property 3: No-budget configuration means no budget behavior", () => {
    /**
     * Arbitrary that generates BudgetConfigInput objects that never include tokenBudget.
     * May include other fields (overshootFraction, enabled) to ensure they alone
     * don't trigger budget creation.
     */
    const budgetConfigInputWithoutTokenBudget: fc.Arbitrary<BudgetConfigInput | undefined> =
        fc.oneof(
            fc.constant(undefined),
            fc.record(
                {
                    overshootFraction: fc.double({ min: 0, max: 1, noNaN: true }),
                    enabled: fc.boolean(),
                },
                { requiredKeys: [] },
            ),
        );

    it("resolveBudgetConfig returns undefined when neither input provides tokenBudget", () => {
        fc.assert(
            fc.property(
                budgetConfigInputWithoutTokenBudget,
                budgetConfigInputWithoutTokenBudget,
                (goalBudget, configBudget) => {
                    const result = resolveBudgetConfig(goalBudget, configBudget);
                    expect(result).toBeUndefined();
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 1: Budget config resolution applies defaults and merges correctly
 *
 * **Validates: Requirements 1.1, 1.4**
 *
 * For any two partial budget config inputs (one from AgentGoal, one from AgentConfig),
 * `resolveBudgetConfig` SHALL return a `BudgetConfig` where:
 * (a) fields present in the AgentGoal input take precedence over AgentConfig fields,
 * (b) fields absent from both inputs receive their defaults (overshootFraction: 0.10, enabled: true),
 * (c) the result is `undefined` only when neither input provides a `tokenBudget`.
 */
describe("Property 1: Budget config resolution applies defaults and merges correctly", () => {
    /**
     * Generates a BudgetConfigInput where optional fields are truly absent (not set to undefined).
     * This matches real-world usage where partial objects omit keys rather than setting them to undefined.
     */
    const arbBudgetConfigInput: fc.Arbitrary<BudgetConfigInput | undefined> = fc.oneof(
        fc.constant(undefined as BudgetConfigInput | undefined),
        fc.tuple(
            fc.option(fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
            fc.option(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
            fc.option(fc.boolean(), { nil: undefined }),
        ).map(([tokenBudget, overshootFraction, enabled]) => {
            const input: Record<string, unknown> = {};
            if (tokenBudget !== undefined) input.tokenBudget = tokenBudget;
            if (overshootFraction !== undefined) input.overshootFraction = overshootFraction;
            if (enabled !== undefined) input.enabled = enabled;
            return input as BudgetConfigInput;
        }),
    );

    it("goal tokenBudget takes precedence over config tokenBudget", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                (goalBudget, configBudget) => {
                    const goal: BudgetConfigInput = { tokenBudget: goalBudget };
                    const config: BudgetConfigInput = { tokenBudget: configBudget };
                    const result = resolveBudgetConfig(goal, config);
                    expect(result).toBeDefined();
                    expect(result!.tokenBudget).toBe(goalBudget);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("defaults are always applied for missing fields (overshootFraction: 0.10, enabled: true)", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                (tokenBudget) => {
                    // Only provide tokenBudget, no other fields
                    const goal: BudgetConfigInput = { tokenBudget };
                    const result = resolveBudgetConfig(goal, undefined);
                    expect(result).toBeDefined();
                    expect(result!.overshootFraction).toBe(0.10);
                    expect(result!.enabled).toBe(true);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("result is always a valid BudgetConfig when tokenBudget is present in either input", () => {
        fc.assert(
            fc.property(
                arbBudgetConfigInput,
                arbBudgetConfigInput,
                (goalBudget, configBudget) => {
                    const result = resolveBudgetConfig(goalBudget, configBudget);

                    // Determine if tokenBudget is present in either input (key exists with defined value)
                    const goalHasToken = goalBudget !== undefined && "tokenBudget" in goalBudget && goalBudget.tokenBudget !== undefined;
                    const configHasToken = configBudget !== undefined && "tokenBudget" in configBudget && configBudget.tokenBudget !== undefined;
                    const hasTokenBudget = goalHasToken || configHasToken;

                    if (hasTokenBudget) {
                        // Result must be defined and have all required fields
                        expect(result).toBeDefined();
                        expect(typeof result!.tokenBudget).toBe("number");
                        expect(typeof result!.overshootFraction).toBe("number");
                        expect(typeof result!.enabled).toBe("boolean");

                        // Goal tokenBudget wins over config tokenBudget
                        if (goalHasToken) {
                            expect(result!.tokenBudget).toBe(goalBudget!.tokenBudget);
                        } else {
                            expect(result!.tokenBudget).toBe(configBudget!.tokenBudget);
                        }

                        // Goal overshootFraction wins, then config, then default
                        const goalHasOvershoot = goalBudget !== undefined && "overshootFraction" in goalBudget;
                        const configHasOvershoot = configBudget !== undefined && "overshootFraction" in configBudget;
                        const expectedOvershoot =
                            (goalHasOvershoot ? goalBudget!.overshootFraction :
                            configHasOvershoot ? configBudget!.overshootFraction :
                            0.10);
                        expect(result!.overshootFraction).toBe(expectedOvershoot);

                        // Goal enabled wins, then config, then default
                        const goalHasEnabled = goalBudget !== undefined && "enabled" in goalBudget;
                        const configHasEnabled = configBudget !== undefined && "enabled" in configBudget;
                        const expectedEnabled =
                            (goalHasEnabled ? goalBudget!.enabled :
                            configHasEnabled ? configBudget!.enabled :
                            true);
                        expect(result!.enabled).toBe(expectedEnabled);
                    } else {
                        // No tokenBudget means undefined result
                        expect(result).toBeUndefined();
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
