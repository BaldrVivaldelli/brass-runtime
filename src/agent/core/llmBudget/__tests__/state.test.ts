import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { initBudgetState, updateBudgetState } from "../state";
import type { BudgetState, TokenUsage, ModelTier } from "../types";

/**
 * Property 4: BudgetState accumulation invariant
 *
 * **Validates: Requirements 2.2, 2.4**
 *
 * For any sequence of TokenUsage records applied to an initial BudgetState via
 * updateBudgetState, the resulting state satisfies:
 * - totalInputTokens equals the sum of all inputTokens
 * - totalOutputTokens equals the sum of all outputTokens
 * - totalTokens equals totalInputTokens + totalOutputTokens
 * - callCount equals the number of updates applied
 * - calls.length equals the number of updates applied
 */

/** Arbitrary for a valid TokenUsage with non-negative integer token counts. */
const arbTokenUsage: fc.Arbitrary<TokenUsage> = fc.record({
    inputTokens: fc.nat({ max: 100_000 }),
    outputTokens: fc.nat({ max: 100_000 }),
});

/** Arbitrary for a valid ModelTier. */
const arbModelTier: fc.Arbitrary<ModelTier> = fc.constantFrom("small", "large");

/** Arbitrary for a confidence score in [0, 1]. */
const arbConfidence: fc.Arbitrary<number> = fc.double({ min: 0, max: 1, noNaN: true });

/** Arbitrary for the estimated flag. */
const arbEstimated: fc.Arbitrary<boolean> = fc.boolean();

/** Arbitrary for a single update record (usage + metadata). */
const arbUpdateRecord = fc.record({
    usage: arbTokenUsage,
    tier: arbModelTier,
    confidence: arbConfidence,
    estimated: arbEstimated,
});

describe("Feature: llm-budget-optimization, Property 4: BudgetState accumulation invariant", () => {
    it("After N updates, totalTokens === totalInputTokens + totalOutputTokens", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 0, maxLength: 50 }),
                (updates) => {
                    let state: BudgetState = initBudgetState();

                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    expect(state.totalTokens).toBe(state.totalInputTokens + state.totalOutputTokens);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("After N updates, callCount === N", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 0, maxLength: 50 }),
                (updates) => {
                    let state: BudgetState = initBudgetState();

                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    expect(state.callCount).toBe(updates.length);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("After N updates, calls.length === N", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 0, maxLength: 50 }),
                (updates) => {
                    let state: BudgetState = initBudgetState();

                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    expect(state.calls.length).toBe(updates.length);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("totalInputTokens equals sum of all individual usage.inputTokens", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 0, maxLength: 50 }),
                (updates) => {
                    let state: BudgetState = initBudgetState();

                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    const expectedInputTokens = updates.reduce(
                        (sum, { usage }) => sum + usage.inputTokens,
                        0,
                    );
                    expect(state.totalInputTokens).toBe(expectedInputTokens);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("totalOutputTokens equals sum of all individual usage.outputTokens", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 0, maxLength: 50 }),
                (updates) => {
                    let state: BudgetState = initBudgetState();

                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    const expectedOutputTokens = updates.reduce(
                        (sum, { usage }) => sum + usage.outputTokens,
                        0,
                    );
                    expect(state.totalOutputTokens).toBe(expectedOutputTokens);
                },
            ),
            { numRuns: 100 },
        );
    });
});

/**
 * Property 5: BudgetState immutability
 *
 * **Validates: Requirements 2.3**
 *
 * Calling `updateBudgetState` does NOT mutate the original state object.
 * After update, the original state's `totalTokens`, `callCount`, and `calls` array remain unchanged.
 * The returned state is a different object reference.
 */
describe("Feature: llm-budget-optimization, Property 5: BudgetState immutability", () => {
    it("updateBudgetState returns a different object reference than the input", () => {
        fc.assert(
            fc.property(
                arbTokenUsage,
                arbModelTier,
                arbConfidence,
                arbEstimated,
                (usage, tier, confidence, estimated) => {
                    const original = initBudgetState();
                    const updated = updateBudgetState(original, usage, tier, confidence, estimated);
                    expect(updated).not.toBe(original);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("updateBudgetState does not mutate the original state's totalTokens", () => {
        fc.assert(
            fc.property(
                arbTokenUsage,
                arbModelTier,
                arbConfidence,
                arbEstimated,
                (usage, tier, confidence, estimated) => {
                    const original = initBudgetState();
                    const originalTotalTokens = original.totalTokens;
                    updateBudgetState(original, usage, tier, confidence, estimated);
                    expect(original.totalTokens).toBe(originalTotalTokens);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("updateBudgetState does not mutate the original state's callCount", () => {
        fc.assert(
            fc.property(
                arbTokenUsage,
                arbModelTier,
                arbConfidence,
                arbEstimated,
                (usage, tier, confidence, estimated) => {
                    const original = initBudgetState();
                    const originalCallCount = original.callCount;
                    updateBudgetState(original, usage, tier, confidence, estimated);
                    expect(original.callCount).toBe(originalCallCount);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("updateBudgetState does not mutate the original state's calls array", () => {
        fc.assert(
            fc.property(
                arbTokenUsage,
                arbModelTier,
                arbConfidence,
                arbEstimated,
                (usage, tier, confidence, estimated) => {
                    const original = initBudgetState();
                    const originalCallsLength = original.calls.length;
                    updateBudgetState(original, usage, tier, confidence, estimated);
                    expect(original.calls.length).toBe(originalCallsLength);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("updateBudgetState preserves all fields of a non-zero state after update", () => {
        fc.assert(
            fc.property(
                fc.array(arbUpdateRecord, { minLength: 1, maxLength: 10 }),
                arbTokenUsage,
                (updates, extraUsage) => {
                    // Build up a non-zero state
                    let state: BudgetState = initBudgetState();
                    for (const { usage, tier, confidence, estimated } of updates) {
                        state = updateBudgetState(state, usage, tier, confidence, estimated);
                    }

                    // Snapshot the state before the next update
                    const snapshotTotalInputTokens = state.totalInputTokens;
                    const snapshotTotalOutputTokens = state.totalOutputTokens;
                    const snapshotTotalTokens = state.totalTokens;
                    const snapshotCallCount = state.callCount;
                    const snapshotCallsLength = state.calls.length;

                    // Apply one more update
                    const updated = updateBudgetState(state, extraUsage, "small", 0.5, false);

                    // Original state must be unchanged
                    expect(state.totalInputTokens).toBe(snapshotTotalInputTokens);
                    expect(state.totalOutputTokens).toBe(snapshotTotalOutputTokens);
                    expect(state.totalTokens).toBe(snapshotTotalTokens);
                    expect(state.callCount).toBe(snapshotCallCount);
                    expect(state.calls.length).toBe(snapshotCallsLength);

                    // Updated state must be a different reference
                    expect(updated).not.toBe(state);
                },
            ),
            { numRuns: 200 },
        );
    });
});
