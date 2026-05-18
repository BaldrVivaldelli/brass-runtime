import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { routeModel, extractComplexitySignals } from "../router";
import { initBudgetState } from "../state";
import type { AgentState, AgentGoal, Observation } from "../../types";
import type { BudgetState } from "../types";

/**
 * Property 11: ModelRouter output domain and threshold logic
 *
 * **Validates: Requirements 5.1, 5.3, 5.4**
 *
 * For any AgentState and BudgetState, routeModel SHALL return exactly "small" or "large".
 * When all extracted complexity signals are below their respective thresholds
 * (goal length < 500, files read < 5, search matches < 30, no validation errors,
 * repair attempts < 1), the result SHALL be "small".
 * When any signal meets or exceeds its threshold, the result SHALL be "large".
 * The function is deterministic.
 */

// --- Arbitraries ---

/** Arbitrary for a minimal AgentGoal with configurable text length. */
const arbGoal = (textLength: number): fc.Arbitrary<AgentGoal> =>
    fc.constant({
        id: "test-goal",
        cwd: "/test",
        text: "x".repeat(textLength),
        mode: "write" as const,
    });

/** Arbitrary for a goal with arbitrary text length. */
const arbGoalWithLength: fc.Arbitrary<AgentGoal> = fc.nat({ max: 2000 }).map((len) => ({
    id: "test-goal",
    cwd: "/test",
    text: "x".repeat(len),
    mode: "write" as const,
}));

/** Arbitrary for fs.fileRead observations. */
const arbFileReadObs = (count: number): fc.Arbitrary<readonly Observation[]> =>
    fc.constant(
        Array.from({ length: count }, (_, i) => ({
            type: "fs.fileRead" as const,
            path: `/file${i}.ts`,
            content: "content",
        })),
    );

/** Arbitrary for fs.searchResult observations with a given total match count. */
const arbSearchResultObs = (matchCount: number): fc.Arbitrary<readonly Observation[]> =>
    fc.constant(
        matchCount > 0
            ? [
                {
                    type: "fs.searchResult" as const,
                    query: "test",
                    matches: Array.from({ length: matchCount }, (_, i) => ({
                        path: `/file${i}.ts`,
                        line: i + 1,
                        text: `match ${i}`,
                    })),
                },
            ]
            : [],
    );

/** Arbitrary for shell.result observations with non-zero exit codes (validation errors). */
const arbValidationErrorObs = (hasErrors: boolean): fc.Arbitrary<readonly Observation[]> =>
    fc.constant(
        hasErrors
            ? [{ type: "shell.result" as const, command: ["npm", "test"], exitCode: 1, stdout: "", stderr: "error" }]
            : [],
    );

/** Arbitrary for llm.response observations with purpose "patch" (repair attempts). */
const arbRepairObs = (count: number): fc.Arbitrary<readonly Observation[]> =>
    fc.constant(
        Array.from({ length: count }, () => ({
            type: "llm.response" as const,
            purpose: "patch" as const,
            content: "patch content",
        })),
    );

/** Builds an AgentState from components. */
const makeAgentState = (
    goal: AgentGoal,
    observations: readonly Observation[],
): AgentState => ({
    goal,
    phase: "planning",
    observations,
    errors: [],
    steps: 0,
});

const budgetState: BudgetState = initBudgetState();

describe("Feature: llm-budget-optimization, Property 11: ModelRouter output domain and threshold logic", () => {
    describe("output domain", () => {
        it("routeModel always returns either 'small' or 'large' for any AgentState", () => {
            fc.assert(
                fc.property(
                    fc.nat({ max: 2000 }),
                    fc.nat({ max: 20 }),
                    fc.nat({ max: 100 }),
                    fc.boolean(),
                    fc.nat({ max: 10 }),
                    (goalLen, filesRead, searchMatches, hasErrors, repairAttempts) => {
                        const observations: Observation[] = [
                            ...Array.from({ length: filesRead }, (_, i) => ({
                                type: "fs.fileRead" as const,
                                path: `/file${i}.ts`,
                                content: "content",
                            })),
                            ...(searchMatches > 0
                                ? [{
                                    type: "fs.searchResult" as const,
                                    query: "q",
                                    matches: Array.from({ length: searchMatches }, (_, i) => ({
                                        path: `/f${i}.ts`,
                                        line: i,
                                        text: `m${i}`,
                                    })),
                                }]
                                : []),
                            ...(hasErrors
                                ? [{ type: "shell.result" as const, command: ["test"], exitCode: 1, stdout: "", stderr: "" }]
                                : []),
                            ...Array.from({ length: repairAttempts }, () => ({
                                type: "llm.response" as const,
                                purpose: "patch" as const,
                                content: "patch",
                            })),
                        ];

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "a".repeat(goalLen), mode: "write" },
                            observations,
                        );

                        const result = routeModel(state, budgetState);
                        expect(result === "small" || result === "large").toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("all signals below thresholds → 'small'", () => {
        it("returns 'small' when all complexity signals are below default thresholds", () => {
            fc.assert(
                fc.property(
                    // goalLength < 500
                    fc.nat({ max: 499 }),
                    // filesRead < 5
                    fc.nat({ max: 4 }),
                    // searchMatches < 30
                    fc.nat({ max: 29 }),
                    // repairAttempts < 1 (i.e., 0)
                    fc.constant(0),
                    (goalLen, filesRead, searchMatches, repairAttempts) => {
                        const observations: Observation[] = [
                            ...Array.from({ length: filesRead }, (_, i) => ({
                                type: "fs.fileRead" as const,
                                path: `/file${i}.ts`,
                                content: "content",
                            })),
                            ...(searchMatches > 0
                                ? [{
                                    type: "fs.searchResult" as const,
                                    query: "q",
                                    matches: Array.from({ length: searchMatches }, (_, i) => ({
                                        path: `/f${i}.ts`,
                                        line: i,
                                        text: `m${i}`,
                                    })),
                                }]
                                : []),
                            // No validation errors (no shell.result with exitCode !== 0)
                            // No repair attempts
                            ...Array.from({ length: repairAttempts }, () => ({
                                type: "llm.response" as const,
                                purpose: "patch" as const,
                                content: "patch",
                            })),
                        ];

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "a".repeat(goalLen), mode: "write" },
                            observations,
                        );

                        expect(routeModel(state, budgetState)).toBe("small");
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("any signal at or above threshold → 'large'", () => {
        it("returns 'large' when goalLength >= 500", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 500, max: 5000 }),
                    (goalLen) => {
                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "a".repeat(goalLen), mode: "write" },
                            [],
                        );

                        expect(routeModel(state, budgetState)).toBe("large");
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("returns 'large' when filesRead >= 5", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 5, max: 50 }),
                    (filesRead) => {
                        const observations: Observation[] = Array.from(
                            { length: filesRead },
                            (_, i) => ({
                                type: "fs.fileRead" as const,
                                path: `/file${i}.ts`,
                                content: "content",
                            }),
                        );

                        // Keep goal short so only filesRead triggers "large"
                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "short", mode: "write" },
                            observations,
                        );

                        expect(routeModel(state, budgetState)).toBe("large");
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("returns 'large' when searchMatches >= 30", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 30, max: 200 }),
                    (matchCount) => {
                        const observations: Observation[] = [
                            {
                                type: "fs.searchResult" as const,
                                query: "q",
                                matches: Array.from({ length: matchCount }, (_, i) => ({
                                    path: `/f${i}.ts`,
                                    line: i,
                                    text: `m${i}`,
                                })),
                            },
                        ];

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "short", mode: "write" },
                            observations,
                        );

                        expect(routeModel(state, budgetState)).toBe("large");
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("returns 'large' when hasValidationErrors is true", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 255 }),
                    (exitCode) => {
                        const observations: Observation[] = [
                            {
                                type: "shell.result" as const,
                                command: ["npm", "test"],
                                exitCode,
                                stdout: "",
                                stderr: "error",
                            },
                        ];

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "short", mode: "write" },
                            observations,
                        );

                        expect(routeModel(state, budgetState)).toBe("large");
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("returns 'large' when repairAttempts >= 1", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10 }),
                    (repairAttempts) => {
                        const observations: Observation[] = Array.from(
                            { length: repairAttempts },
                            () => ({
                                type: "llm.response" as const,
                                purpose: "patch" as const,
                                content: "patch content",
                            }),
                        );

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "short", mode: "write" },
                            observations,
                        );

                        expect(routeModel(state, budgetState)).toBe("large");
                    },
                ),
                { numRuns: 100 },
            );
        });
    });

    describe("determinism", () => {
        it("calling routeModel twice with identical inputs produces identical outputs", () => {
            fc.assert(
                fc.property(
                    fc.nat({ max: 2000 }),
                    fc.nat({ max: 20 }),
                    fc.nat({ max: 100 }),
                    fc.boolean(),
                    fc.nat({ max: 10 }),
                    (goalLen, filesRead, searchMatches, hasErrors, repairAttempts) => {
                        const observations: Observation[] = [
                            ...Array.from({ length: filesRead }, (_, i) => ({
                                type: "fs.fileRead" as const,
                                path: `/file${i}.ts`,
                                content: "content",
                            })),
                            ...(searchMatches > 0
                                ? [{
                                    type: "fs.searchResult" as const,
                                    query: "q",
                                    matches: Array.from({ length: searchMatches }, (_, i) => ({
                                        path: `/f${i}.ts`,
                                        line: i,
                                        text: `m${i}`,
                                    })),
                                }]
                                : []),
                            ...(hasErrors
                                ? [{ type: "shell.result" as const, command: ["test"], exitCode: 1, stdout: "", stderr: "" }]
                                : []),
                            ...Array.from({ length: repairAttempts }, () => ({
                                type: "llm.response" as const,
                                purpose: "patch" as const,
                                content: "patch",
                            })),
                        ];

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "a".repeat(goalLen), mode: "write" },
                            observations,
                        );

                        const result1 = routeModel(state, budgetState);
                        const result2 = routeModel(state, budgetState);
                        expect(result1).toBe(result2);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    describe("extractComplexitySignals correctness", () => {
        it("correctly counts filesRead from fs.fileRead observations", () => {
            fc.assert(
                fc.property(
                    fc.nat({ max: 20 }),
                    (count) => {
                        const observations: Observation[] = Array.from(
                            { length: count },
                            (_, i) => ({
                                type: "fs.fileRead" as const,
                                path: `/file${i}.ts`,
                                content: "content",
                            }),
                        );

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "goal", mode: "write" },
                            observations,
                        );

                        const signals = extractComplexitySignals(state);
                        expect(signals.filesRead).toBe(count);
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("correctly sums searchMatches across all fs.searchResult observations", () => {
            fc.assert(
                fc.property(
                    fc.array(fc.nat({ max: 20 }), { minLength: 0, maxLength: 5 }),
                    (matchCounts) => {
                        const observations: Observation[] = matchCounts.map((count, idx) => ({
                            type: "fs.searchResult" as const,
                            query: `query${idx}`,
                            matches: Array.from({ length: count }, (_, i) => ({
                                path: `/f${i}.ts`,
                                line: i,
                                text: `m${i}`,
                            })),
                        }));

                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "goal", mode: "write" },
                            observations,
                        );

                        const signals = extractComplexitySignals(state);
                        const expectedTotal = matchCounts.reduce((sum, c) => sum + c, 0);
                        expect(signals.searchMatches).toBe(expectedTotal);
                    },
                ),
                { numRuns: 100 },
            );
        });

        it("goalLength matches state.goal.text.length", () => {
            fc.assert(
                fc.property(
                    fc.nat({ max: 2000 }),
                    (len) => {
                        const state = makeAgentState(
                            { id: "g", cwd: "/", text: "a".repeat(len), mode: "write" },
                            [],
                        );

                        const signals = extractComplexitySignals(state);
                        expect(signals.goalLength).toBe(len);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });
});
