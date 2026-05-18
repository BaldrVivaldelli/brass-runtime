import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractSignals } from "../signalExtractor";
import type { AgentState, Observation } from "../../types";
import type { GoalSignals } from "../types";

/**
 * Property-based tests for signal extractor.
 * Feature: adaptive-patch-strategy
 */

/** Arbitrary for observations relevant to signal extraction. */
const arbObservation: fc.Arbitrary<Observation> = fc.oneof(
    fc.record({
        type: fc.constant("fs.fileRead" as const),
        path: fc.oneof(
            fc.constant("package.json"),
            fc.constant("src/index.ts"),
            fc.constant("README.md"),
        ),
        content: fc.string({ minLength: 0, maxLength: 50 }),
    }),
    fc.record({
        type: fc.constant("fs.searchResult" as const),
        query: fc.string({ minLength: 1, maxLength: 20 }),
        matches: fc.array(
            fc.record({
                path: fc.string({ minLength: 1, maxLength: 30 }),
                line: fc.nat({ max: 1000 }),
                text: fc.string({ minLength: 0, maxLength: 50 }),
            }),
            { minLength: 0, maxLength: 10 },
        ),
    }),
    fc.record({
        type: fc.constant("fs.exists" as const),
        path: fc.string({ minLength: 1, maxLength: 30 }),
        exists: fc.boolean(),
    }),
);

/** Arbitrary for goal text that is non-empty. */
const arbGoalText = fc.string({ minLength: 1, maxLength: 500 });

/** Arbitrary for a minimal AgentState suitable for signal extraction. */
const arbAgentState = (goalText: fc.Arbitrary<string> = arbGoalText): fc.Arbitrary<AgentState> =>
    fc.record({
        goal: fc.record({
            id: fc.constant("test-goal"),
            cwd: fc.constant("/tmp/test"),
            text: goalText,
            mode: fc.constant("write" as const),
        }),
        phase: fc.constant("planning" as const),
        observations: fc.array(arbObservation, { minLength: 0, maxLength: 10 }),
        errors: fc.constant([]),
        steps: fc.nat({ max: 20 }),
    });

describe("signalExtractor property tests", () => {
    /**
     * Property 8: Signal extractor determinism
     *
     * For any AgentState, calling extractSignals twice with the same state
     * produces deeply equal GoalSignals objects.
     *
     * Feature: adaptive-patch-strategy, Property 8: Signal extractor determinism
     * **Validates: Requirements 5.3, 10.4**
     */
    describe("Property 8: Signal extractor determinism", () => {
        it("extractSignals produces identical output for identical input", () => {
            fc.assert(
                fc.property(arbAgentState(), (state) => {
                    const result1 = extractSignals(state);
                    const result2 = extractSignals(state);
                    expect(result1).toStrictEqual(result2);
                }),
                { numRuns: 100 },
            );
        });
    });

    /**
     * Property 9: Signal extractor completeness
     *
     * For any AgentState with non-empty goal text, extractSignals returns a GoalSignals
     * with valid goalLengthCategory (short/medium/long), boolean hasFilePaths,
     * keywords record with all 8 boolean fields, and contextSignals with non-negative integer counts.
     *
     * Feature: adaptive-patch-strategy, Property 9: Signal extractor completeness
     * **Validates: Requirements 5.1, 5.2**
     */
    describe("Property 9: Signal extractor completeness", () => {
        it("extractSignals returns a complete GoalSignals object", () => {
            fc.assert(
                fc.property(arbAgentState(), (state) => {
                    const signals: GoalSignals = extractSignals(state);

                    // goalLengthCategory is one of the valid values
                    expect(["short", "medium", "long"]).toContain(signals.goalLengthCategory);

                    // hasFilePaths is a boolean
                    expect(typeof signals.hasFilePaths).toBe("boolean");

                    // keywords has all 8 boolean fields
                    const expectedKeywords = [
                        "refactor", "rename", "bug", "fix",
                        "add", "create", "move", "delete",
                    ] as const;
                    for (const kw of expectedKeywords) {
                        expect(typeof signals.keywords[kw]).toBe("boolean");
                    }

                    // contextSignals has non-negative integer counts
                    expect(typeof signals.contextSignals.hasProjectProfile).toBe("boolean");
                    expect(signals.contextSignals.searchResultCount).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(signals.contextSignals.searchResultCount)).toBe(true);
                    expect(signals.contextSignals.discoveredFileCount).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(signals.contextSignals.discoveredFileCount)).toBe(true);
                }),
                { numRuns: 100 },
            );
        });
    });
});
