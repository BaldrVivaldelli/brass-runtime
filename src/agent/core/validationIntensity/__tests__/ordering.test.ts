import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { failFastScore, sortByFailFast, commandKey } from "../ordering";
import type { CommandStats, ValidationHistory } from "../types";

/**
 * Property-based tests for fail-fast ordering.
 * Feature: adaptive-validation-intensity
 */
describe("Fail-fast ordering property tests", () => {
    /** Arbitrary for a ProjectCommand (1-4 non-empty string parts) */
    const arbCommand = fc.array(
        fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/),
        { minLength: 1, maxLength: 4 },
    );

    /** Arbitrary for CommandStats with failures <= totalRuns */
    const arbCommandStats: fc.Arbitrary<CommandStats> = fc
        .record({
            totalRuns: fc.nat({ max: 1000 }),
            failures: fc.nat({ max: 1000 }),
            avgTimeToFailureMs: fc.nat({ max: 60000 }),
        })
        .filter((s) => s.failures <= s.totalRuns);

    /** Arbitrary for CommandStats with totalRuns > 0 (has history) */
    const arbCommandStatsWithHistory: fc.Arbitrary<CommandStats> = fc
        .record({
            totalRuns: fc.integer({ min: 1, max: 1000 }),
            failures: fc.nat({ max: 1000 }),
            avgTimeToFailureMs: fc.nat({ max: 60000 }),
        })
        .filter((s) => s.failures <= s.totalRuns);

    /**
     * Property 8: Fail-fast ordering
     *
     * For any list of validation commands where at least two commands have
     * history with different fail-fast scores, sortByFailFast SHALL place
     * the command with the higher score before the command with the lower
     * score in the output.
     *
     * **Validates: Requirements 3.1, 3.2, 8.3**
     */
    describe("Property 8: Fail-fast ordering", () => {
        it("commands with history are sorted by fail-fast score descending", () => {
            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 2, maxLength: 10 }),
                    fc.array(arbCommandStatsWithHistory, { minLength: 2, maxLength: 10 }),
                    (commands, statsArray) => {
                        // Ensure unique command keys
                        const uniqueCommands: (readonly string[])[] = [];
                        const seenKeys = new Set<string>();
                        for (const cmd of commands) {
                            const key = commandKey(cmd);
                            if (!seenKeys.has(key)) {
                                seenKeys.add(key);
                                uniqueCommands.push(cmd);
                            }
                        }
                        if (uniqueCommands.length < 2) return;

                        // Build history with stats for all commands
                        const historyCommands: Record<string, CommandStats> = {};
                        for (let i = 0; i < uniqueCommands.length; i++) {
                            const key = commandKey(uniqueCommands[i]);
                            historyCommands[key] = statsArray[i % statsArray.length];
                        }

                        const history: ValidationHistory = { version: 1, commands: historyCommands };
                        const sorted = sortByFailFast(uniqueCommands, history);

                        // Verify: for any two adjacent commands in the output that both
                        // have history, the first should have score >= the second
                        for (let i = 0; i < sorted.length - 1; i++) {
                            const scoreA = failFastScore(historyCommands[commandKey(sorted[i])]);
                            const scoreB = failFastScore(historyCommands[commandKey(sorted[i + 1])]);
                            expect(scoreA).toBeGreaterThanOrEqual(scoreB);
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 9: No-history commands trail and preserve order
     *
     * For any list of validation commands containing a mix of commands with
     * history (totalRuns > 0) and commands without history (totalRuns === 0),
     * sortByFailFast SHALL place all commands with history before all commands
     * without history, and the relative order of commands without history SHALL
     * match their relative order in the input.
     *
     * **Validates: Requirements 3.3, 3.4, 6.1, 6.2, 8.4**
     */
    describe("Property 9: No-history commands trail and preserve order", () => {
        it("commands without history trail and preserve their original relative order", () => {
            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 3, maxLength: 10 }),
                    fc.array(fc.boolean(), { minLength: 3, maxLength: 10 }),
                    arbCommandStatsWithHistory,
                    (commands, hasHistoryFlags, stats) => {
                        // Ensure unique command keys
                        const uniqueCommands: (readonly string[])[] = [];
                        const seenKeys = new Set<string>();
                        for (const cmd of commands) {
                            const key = commandKey(cmd);
                            if (!seenKeys.has(key)) {
                                seenKeys.add(key);
                                uniqueCommands.push(cmd);
                            }
                        }
                        if (uniqueCommands.length < 3) return;

                        // Assign history to some commands, not others
                        const historyCommands: Record<string, CommandStats> = {};
                        const withHistoryIndices: number[] = [];
                        const withoutHistoryIndices: number[] = [];

                        for (let i = 0; i < uniqueCommands.length; i++) {
                            const hasHistory = hasHistoryFlags[i % hasHistoryFlags.length];
                            if (hasHistory) {
                                historyCommands[commandKey(uniqueCommands[i])] = stats;
                                withHistoryIndices.push(i);
                            } else {
                                withoutHistoryIndices.push(i);
                            }
                        }

                        // Need at least one with and one without history
                        if (withHistoryIndices.length === 0 || withoutHistoryIndices.length === 0) return;

                        const history: ValidationHistory = { version: 1, commands: historyCommands };
                        const sorted = sortByFailFast(uniqueCommands, history);

                        // Find the boundary: all with-history commands come first
                        const sortedWithHistory: (readonly string[])[] = [];
                        const sortedWithoutHistory: (readonly string[])[] = [];

                        for (const cmd of sorted) {
                            const key = commandKey(cmd);
                            if (historyCommands[key] && historyCommands[key].totalRuns > 0) {
                                sortedWithHistory.push(cmd);
                            } else {
                                sortedWithoutHistory.push(cmd);
                            }
                        }

                        // All with-history commands appear before without-history
                        expect(sortedWithHistory.length).toBe(withHistoryIndices.length);
                        expect(sortedWithoutHistory.length).toBe(withoutHistoryIndices.length);

                        // The first N items in sorted should all be with-history
                        for (let i = 0; i < sortedWithHistory.length; i++) {
                            expect(sorted[i]).toEqual(sortedWithHistory[i]);
                        }

                        // Without-history commands preserve their original relative order
                        const originalWithoutHistory = withoutHistoryIndices.map((i) => uniqueCommands[i]);
                        expect(sortedWithoutHistory).toEqual(originalWithoutHistory);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 10: Score computation correctness
     *
     * For any CommandStats with totalRuns > 0 and avgTimeToFailureMs > 0,
     * failFastScore SHALL return (failures / totalRuns) * (1 / avgTimeToFailureMs).
     * When totalRuns === 0 or avgTimeToFailureMs === 0, failFastScore SHALL return 0.
     *
     * **Validates: Requirements 3.2, 3.5**
     */
    describe("Property 10: Score computation correctness", () => {
        it("failFastScore returns (failures/totalRuns) * (1/avgTimeToFailureMs) when both > 0", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10000 }),
                    fc.integer({ min: 0, max: 10000 }),
                    fc.integer({ min: 1, max: 60000 }),
                    (totalRuns, failures, avgTimeToFailureMs) => {
                        // Ensure failures <= totalRuns
                        const actualFailures = Math.min(failures, totalRuns);
                        const stats: CommandStats = {
                            totalRuns,
                            failures: actualFailures,
                            avgTimeToFailureMs,
                        };

                        const score = failFastScore(stats);
                        const expected = (actualFailures / totalRuns) * (1 / avgTimeToFailureMs);

                        expect(score).toBeCloseTo(expected, 10);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("failFastScore returns 0 when totalRuns is 0", () => {
            fc.assert(
                fc.property(
                    fc.nat({ max: 60000 }),
                    (avgTimeToFailureMs) => {
                        const stats: CommandStats = {
                            totalRuns: 0,
                            failures: 0,
                            avgTimeToFailureMs,
                        };
                        expect(failFastScore(stats)).toBe(0);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("failFastScore returns 0 when avgTimeToFailureMs is 0", () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10000 }),
                    fc.nat({ max: 10000 }),
                    (totalRuns, failures) => {
                        const actualFailures = Math.min(failures, totalRuns);
                        const stats: CommandStats = {
                            totalRuns,
                            failures: actualFailures,
                            avgTimeToFailureMs: 0,
                        };
                        expect(failFastScore(stats)).toBe(0);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
