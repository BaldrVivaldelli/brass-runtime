import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deriveBaseLevel, computeVerbosityLevel, reduceLevel } from "../signals";
import type { AdaptationSignals, VerbosityLevel } from "../types";
import { VERBOSITY_LEVELS, NARROW_TTY_THRESHOLD, SHORT_RUN_THRESHOLD_MS } from "../types";
import type { HostProfile } from "../../hostProfile";

const arbHostProfile: fc.Arbitrary<HostProfile> = fc.record({
    transport: fc.constantFrom("stdio", "terminal", "mcp", "extension", "ci", "unknown"),
    capabilities: fc.record({
        hasOwnLLM: fc.boolean(),
        wantsJson: fc.boolean(),
        supportsStreamingEvents: fc.boolean(),
        supportsMcp: fc.boolean(),
        canAskApproval: fc.boolean(),
        canRenderDiff: fc.boolean(),
        canApplyPatch: fc.boolean(),
        interactiveTty: fc.boolean(),
    }),
    constraints: fc.record({
        readOnlyByDefault: fc.boolean(),
        patchPreviewRequired: fc.boolean(),
        requireNoNetwork: fc.boolean(),
    }),
    identity: fc.option(fc.record({ name: fc.string(), confidence: fc.double({ min: 0, max: 1, noNaN: true }) }), { nil: undefined }),
    evidence: fc.constant([]),
});

const arbSignals: fc.Arbitrary<AdaptationSignals> = fc.record({
    isPipe: fc.boolean(),
    ttyWidth: fc.option(fc.nat(300), { nil: undefined }),
    runHistory: fc.array(fc.nat(60_000), { minLength: 0, maxLength: 25 }),
    userOverride: fc.constantFrom(undefined, "minimal" as const, "normal" as const, "verbose" as const),
});

const levelIndex = (level: VerbosityLevel): number => VERBOSITY_LEVELS.indexOf(level);

describe("Feature: adaptive-output-verbosity", () => {
    describe("Property 2: Host profile base level derivation", () => {
        /**
         * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 10.4
         */
        it("deriveBaseLevel returns 'minimal' for ci/stdio/wantsJson, 'normal' otherwise", () => {
            fc.assert(
                fc.property(arbHostProfile, (hp) => {
                    const result = deriveBaseLevel(hp);

                    if (hp.transport === "ci" || hp.transport === "stdio") {
                        expect(result).toBe("minimal");
                    } else if (hp.capabilities.wantsJson) {
                        expect(result).toBe("minimal");
                    } else {
                        expect(result).toBe("normal");
                    }
                }),
                { numRuns: 200 },
            );
        });

        it("deriveBaseLevel returns 'normal' when hostProfile is undefined", () => {
            expect(deriveBaseLevel(undefined)).toBe("normal");
        });
    });

    describe("Property 3: CI transport override dominance", () => {
        /**
         * Validates: Requirements 6.1, 6.2, 11.2
         */
        it("computeVerbosityLevel always returns 'minimal' when transport is 'ci' regardless of signals", () => {
            const arbCiProfile = arbHostProfile.map((hp) => ({
                ...hp,
                transport: "ci" as const,
            }));

            fc.assert(
                fc.property(arbCiProfile, arbSignals, (hp, signals) => {
                    const result = computeVerbosityLevel(hp, signals);
                    expect(result).toBe("minimal");
                }),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 4: Signal composition determinism", () => {
        /**
         * Validates: Requirements 11.3
         */
        it("computeVerbosityLevel is deterministic (same inputs produce same output)", () => {
            fc.assert(
                fc.property(
                    fc.option(arbHostProfile, { nil: undefined }),
                    arbSignals,
                    (hp, signals) => {
                        const result1 = computeVerbosityLevel(hp, signals);
                        const result2 = computeVerbosityLevel(hp, signals);
                        expect(result1).toBe(result2);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 5: Reduction signals are monotonically non-increasing", () => {
        /**
         * Validates: Requirements 3.1, 4.1, 5.1, 11.1
         */
        it("final computed level is always <= base level in ordering (minimal < normal < verbose)", () => {
            fc.assert(
                fc.property(
                    fc.option(arbHostProfile, { nil: undefined }),
                    arbSignals,
                    (hp, signals) => {
                        // Compute with no reduction signals to get the effective base
                        const baseLevel = signals.userOverride !== undefined
                            ? signals.userOverride
                            : deriveBaseLevel(hp);

                        // CI override always returns minimal which is <= any base
                        if (hp?.transport === "ci") {
                            expect(levelIndex(computeVerbosityLevel(hp, signals))).toBeLessThanOrEqual(levelIndex(baseLevel));
                            return;
                        }

                        const finalLevel = computeVerbosityLevel(hp, signals);
                        expect(levelIndex(finalLevel)).toBeLessThanOrEqual(levelIndex(baseLevel));
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 6: Pipe detection reduction", () => {
        /**
         * Validates: Requirements 3.1, 3.2
         */
        it("when isPipe is true and base is not 'minimal', level is reduced one step; when false, unchanged by pipe", () => {
            // Test pipe reduction in isolation: no other reduction signals active
            const arbNonCiProfile = arbHostProfile.filter((hp) => hp.transport !== "ci");

            fc.assert(
                fc.property(arbNonCiProfile, fc.boolean(), (hp, isPipe) => {
                    // Isolate pipe signal: no TTY width reduction, no history reduction, no user override
                    const signals: AdaptationSignals = {
                        isPipe,
                        ttyWidth: undefined, // no width reduction
                        runHistory: [], // no history reduction
                        userOverride: undefined, // no user override
                    };

                    const baseLevel = deriveBaseLevel(hp);
                    const result = computeVerbosityLevel(hp, signals);

                    if (isPipe && baseLevel !== "minimal") {
                        expect(result).toBe(reduceLevel(baseLevel));
                    } else if (!isPipe) {
                        // No pipe reduction, and no other signals active
                        expect(result).toBe(baseLevel);
                    }
                    // If isPipe && baseLevel === "minimal", result is still "minimal" (floor)
                }),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 7: TTY width reduction", () => {
        /**
         * Validates: Requirements 4.1, 4.2
         */
        it("when ttyWidth < 80, level is reduced one step; when >= 80 or undefined, unchanged", () => {
            // Test TTY width reduction in isolation
            const arbNonCiProfile = arbHostProfile.filter((hp) => hp.transport !== "ci");

            fc.assert(
                fc.property(
                    arbNonCiProfile,
                    fc.option(fc.nat(300), { nil: undefined }),
                    (hp, ttyWidth) => {
                        // Isolate width signal: no pipe, no history, no user override
                        const signals: AdaptationSignals = {
                            isPipe: false,
                            ttyWidth,
                            runHistory: [],
                            userOverride: undefined,
                        };

                        const baseLevel = deriveBaseLevel(hp);
                        const result = computeVerbosityLevel(hp, signals);

                        if (ttyWidth !== undefined && ttyWidth < NARROW_TTY_THRESHOLD && baseLevel !== "minimal") {
                            expect(result).toBe(reduceLevel(baseLevel));
                        } else {
                            // No width reduction
                            expect(result).toBe(baseLevel);
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 8: Historical duration reduction", () => {
        /**
         * Validates: Requirements 5.1, 5.2, 5.3
         */
        it("when median run < 5000ms and non-empty history, level is reduced one step; when empty or >= 5000ms, unchanged", () => {
            // Test historical duration reduction in isolation
            const arbNonCiProfile = arbHostProfile.filter((hp) => hp.transport !== "ci");

            fc.assert(
                fc.property(
                    arbNonCiProfile,
                    fc.array(fc.nat(60_000), { minLength: 0, maxLength: 25 }),
                    (hp, runHistory) => {
                        // Isolate history signal: no pipe, no width, no user override
                        const signals: AdaptationSignals = {
                            isPipe: false,
                            ttyWidth: undefined,
                            runHistory,
                            userOverride: undefined,
                        };

                        const baseLevel = deriveBaseLevel(hp);
                        const result = computeVerbosityLevel(hp, signals);

                        if (runHistory.length === 0) {
                            // No history → no reduction
                            expect(result).toBe(baseLevel);
                        } else {
                            // Compute median
                            const sorted = [...runHistory].sort((a, b) => a - b);
                            const mid = Math.floor(sorted.length / 2);
                            const med = sorted.length % 2 === 0
                                ? (sorted[mid - 1] + sorted[mid]) / 2
                                : sorted[mid];

                            if (med < SHORT_RUN_THRESHOLD_MS && baseLevel !== "minimal") {
                                expect(result).toBe(reduceLevel(baseLevel));
                            } else {
                                expect(result).toBe(baseLevel);
                            }
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
