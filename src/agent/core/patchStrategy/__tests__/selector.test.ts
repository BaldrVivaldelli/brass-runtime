import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { selectStrategy } from "../selector";
import type {
    PatchStrategy,
    PatchStrategyConfig,
    GoalSignals,
    GoalLengthCategory,
    RewardEntry,
    StrategyRng,
} from "../types";
import { PATCH_STRATEGIES, DEFAULT_STRATEGY } from "../types";

/**
 * Property-based tests for strategy selector.
 * Feature: adaptive-patch-strategy
 */

/** Arbitrary for GoalLengthCategory. */
const arbGoalLengthCategory: fc.Arbitrary<GoalLengthCategory> = fc.constantFrom("short", "medium", "long");

/** Arbitrary for GoalSignals. */
const arbGoalSignals: fc.Arbitrary<GoalSignals> = fc.record({
    goalLengthCategory: arbGoalLengthCategory,
    hasFilePaths: fc.boolean(),
    keywords: fc.record({
        refactor: fc.boolean(),
        rename: fc.boolean(),
        bug: fc.boolean(),
        fix: fc.boolean(),
        add: fc.boolean(),
        create: fc.boolean(),
        move: fc.boolean(),
        delete: fc.boolean(),
    }),
    contextSignals: fc.record({
        hasProjectProfile: fc.boolean(),
        searchResultCount: fc.nat({ max: 100 }),
        discoveredFileCount: fc.nat({ max: 50 }),
    }),
});

/** Arbitrary for PatchStrategyConfig (including undefined). */
const arbConfig: fc.Arbitrary<PatchStrategyConfig | undefined> = fc.oneof(
    fc.constant(undefined),
    fc.record({
        algorithm: fc.oneof(
            fc.constant(undefined),
            fc.constant("thompson" as const),
            fc.constant("exp3" as const),
        ),
        gamma: fc.oneof(fc.constant(undefined), fc.double({ min: 0.01, max: 1, noNaN: true })),
        enabled: fc.oneof(fc.constant(undefined), fc.boolean()),
    }),
);

/** Arbitrary for a PatchStrategy. */
const arbPatchStrategy: fc.Arbitrary<PatchStrategy> = fc.constantFrom(...PATCH_STRATEGIES);

/** Arbitrary for a reward value in [0, 1]. */
const arbReward = fc.double({ min: 0, max: 1, noNaN: true });

/** Arbitrary for a RewardEntry. */
const arbRewardEntry: fc.Arbitrary<RewardEntry> = fc.record({
    arm: arbPatchStrategy,
    reward: arbReward,
    timestamp: fc.nat({ max: 2_000_000_000_000 }),
});

/** Arbitrary for reward history (including empty). */
const arbRewardHistory: fc.Arbitrary<readonly RewardEntry[]> = fc.array(arbRewardEntry, {
    minLength: 0,
    maxLength: 30,
});

/** A deterministic RNG for testing. */
const makeRng = (betaValue: number = 0.5, randomValue: number = 0.5): StrategyRng => ({
    sampleBeta: (_a: number, _b: number) => betaValue,
    random: () => randomValue,
});

/** Arbitrary for a deterministic RNG. */
const arbRng: fc.Arbitrary<StrategyRng> = fc.record({
    sampleBeta: fc.constant((_a: number, _b: number) => 0.5),
    random: fc.double({ min: 0, max: 0.999, noNaN: true }).map((v) => () => v),
});

describe("selector property tests", () => {
    /**
     * Property 1: Strategy selector output validity
     *
     * For any GoalSignals, PatchStrategyConfig, reward history, and RNG,
     * selectStrategy returns exactly one of "direct-patch", "multi-step-patch",
     * or "propose-then-refine".
     *
     * Feature: adaptive-patch-strategy, Property 1: Strategy selector output validity
     * **Validates: Requirements 1.1, 10.3**
     */
    describe("Property 1: Strategy selector output validity", () => {
        it("always returns a valid PatchStrategy value", () => {
            fc.assert(
                fc.property(
                    arbGoalSignals,
                    arbConfig,
                    arbRewardHistory,
                    arbRng,
                    (signals, config, history, rng) => {
                        const result = selectStrategy(signals, config, history, rng);
                        expect(PATCH_STRATEGIES).toContain(result);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 2: Strategy selector purity and immutability
     *
     * For any inputs, calling selectStrategy with same inputs twice produces
     * identical outputs, and input objects remain unchanged.
     *
     * Feature: adaptive-patch-strategy, Property 2: Strategy selector purity and immutability
     * **Validates: Requirements 1.2, 1.4**
     */
    describe("Property 2: Strategy selector purity and immutability", () => {
        it("produces identical output for same inputs and does not mutate inputs", () => {
            fc.assert(
                fc.property(
                    arbGoalSignals,
                    arbConfig,
                    arbRewardHistory,
                    (signals, config, history) => {
                        // Use a deterministic RNG so results are reproducible
                        const rng = makeRng(0.5, 0.5);

                        // Snapshot inputs to check immutability (use JSON for safe deep clone)
                        const signalsSnapshot = JSON.stringify(signals);
                        const configSnapshot = JSON.stringify(config);
                        const historySnapshot = JSON.stringify(history);

                        const result1 = selectStrategy(signals, config, history, rng);
                        const result2 = selectStrategy(signals, config, history, rng);

                        // Same output
                        expect(result1).toBe(result2);

                        // Inputs unchanged (compare serialized form to avoid prototype issues)
                        expect(JSON.stringify(signals)).toBe(signalsSnapshot);
                        expect(JSON.stringify(config)).toBe(configSnapshot);
                        expect(JSON.stringify(history)).toBe(historySnapshot);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 11: Graceful degradation to default strategy
     *
     * For any inputs where reward history is empty (or undefined),
     * selectStrategy returns "direct-patch".
     *
     * Feature: adaptive-patch-strategy, Property 11: Graceful degradation to default strategy
     * **Validates: Requirements 7.1**
     */
    describe("Property 11: Graceful degradation to default strategy", () => {
        it("returns direct-patch when history is empty", () => {
            fc.assert(
                fc.property(arbGoalSignals, arbConfig, arbRng, (signals, config, rng) => {
                    const result = selectStrategy(signals, config, [], rng);
                    expect(result).toBe(DEFAULT_STRATEGY);
                }),
                { numRuns: 100 },
            );
        });
    });
});
