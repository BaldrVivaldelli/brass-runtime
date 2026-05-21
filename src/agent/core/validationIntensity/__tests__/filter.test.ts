import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { filterByIntensity, isTypecheckCommand } from "../filter";
import { commandKey } from "../ordering";
import type { CommandStats, IntensityLevel, ValidationHistory } from "../types";
import { TYPECHECK_PATTERNS } from "../types";

/**
 * Property-based tests for intensity filter.
 * Feature: adaptive-validation-intensity
 */
describe("Intensity filter property tests", () => {
    /** Arbitrary for a ProjectCommand (1-4 non-empty alphanumeric parts) */
    const arbCommand = fc.array(
        fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/),
        { minLength: 1, maxLength: 4 },
    );

    /** Arbitrary for IntensityLevel */
    const arbIntensityLevel: fc.Arbitrary<IntensityLevel> = fc.constantFrom(
        "full" as const,
        "reduced" as const,
        "skip" as const,
    );

    /** Arbitrary for CommandStats with failures <= totalRuns */
    const arbCommandStats: fc.Arbitrary<CommandStats> = fc
        .record({
            totalRuns: fc.nat({ max: 1000 }),
            failures: fc.nat({ max: 1000 }),
            avgTimeToFailureMs: fc.nat({ max: 60000 }),
        })
        .filter((s) => s.failures <= s.totalRuns);

    /** Build a ValidationHistory from a list of commands */
    const buildHistory = (
        commands: readonly (readonly string[])[],
        stats: CommandStats[],
    ): ValidationHistory => {
        const historyCommands: Record<string, CommandStats> = {};
        for (let i = 0; i < commands.length; i++) {
            historyCommands[commandKey(commands[i])] = stats[i % stats.length];
        }
        return { version: 1, commands: historyCommands };
    };

    /** Empty history */
    const emptyHistory: ValidationHistory = { version: 1, commands: {} };

    /**
     * Property 1: Output subset invariant
     *
     * For any list of validation commands, any IntensityLevel, and any
     * ValidationHistory, the output of filterByIntensity SHALL be a subset
     * of the input commands (every element in the output exists in the input,
     * with no duplicates introduced).
     *
     * **Validates: Requirements 1.1, 1.2, 1.4, 5.1, 8.1**
     */
    describe("Property 1: Output subset invariant", () => {
        it("output is always a subset of input commands", () => {
            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 0, maxLength: 10 }),
                    arbIntensityLevel,
                    fc.array(arbCommandStats, { minLength: 1, maxLength: 5 }),
                    (commands, level, statsArray) => {
                        const history = buildHistory(commands, statsArray);
                        const result = filterByIntensity(commands, level, history);

                        // Every element in result must exist in the input
                        const inputKeys = new Set(commands.map(commandKey));
                        for (const cmd of result) {
                            expect(inputKeys.has(commandKey(cmd))).toBe(true);
                        }

                        // Result length should not exceed input length
                        expect(result.length).toBeLessThanOrEqual(commands.length);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 2: Skip intensity produces empty output
     *
     * For any list of validation commands and any ValidationHistory,
     * when IntensityLevel is "skip", filterByIntensity SHALL return an empty array.
     *
     * **Validates: Requirements 1.4**
     */
    describe("Property 2: Skip intensity produces empty output", () => {
        it('"skip" intensity always returns empty array', () => {
            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 0, maxLength: 10 }),
                    fc.array(arbCommandStats, { minLength: 1, maxLength: 5 }),
                    (commands, statsArray) => {
                        const history = buildHistory(commands, statsArray);
                        const result = filterByIntensity(commands, "skip", history);
                        expect(result).toEqual([]);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 3: Full intensity preserves all commands
     *
     * For any non-empty list of validation commands and any ValidationHistory,
     * when IntensityLevel is "full", filterByIntensity SHALL return a list
     * containing exactly the same commands as the input (a permutation of the input).
     *
     * **Validates: Requirements 1.1**
     */
    describe("Property 3: Full intensity preserves all commands", () => {
        it('"full" intensity preserves all commands (same length as input)', () => {
            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 1, maxLength: 10 }),
                    fc.array(arbCommandStats, { minLength: 1, maxLength: 5 }),
                    (commands, statsArray) => {
                        const history = buildHistory(commands, statsArray);
                        const result = filterByIntensity(commands, "full", history);

                        // Same length
                        expect(result.length).toBe(commands.length);

                        // Same set of command keys (permutation)
                        const inputKeys = commands.map(commandKey).sort();
                        const outputKeys = result.map((c) => commandKey(c)).sort();
                        expect(outputKeys).toEqual(inputKeys);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 4: Reduced intensity returns typecheck or falls back to full
     *
     * For any list of validation commands containing at least one typecheck
     * command and any ValidationHistory, when IntensityLevel is "reduced",
     * filterByIntensity SHALL return a singleton list containing only a
     * typecheck command. For any list with no typecheck command,
     * filterByIntensity with "reduced" SHALL return the same result as with "full".
     *
     * **Validates: Requirements 1.2, 1.3, 7.1, 7.3**
     */
    describe("Property 4: Reduced intensity returns typecheck or falls back", () => {
        it('"reduced" returns typecheck command if found', () => {
            // Generate commands where at least one contains a typecheck pattern
            const arbTypecheckPattern = fc.constantFrom(...TYPECHECK_PATTERNS);

            fc.assert(
                fc.property(
                    fc.array(arbCommand, { minLength: 1, maxLength: 5 }),
                    arbTypecheckPattern,
                    fc.array(arbCommandStats, { minLength: 1, maxLength: 3 }),
                    (otherCommands, pattern, statsArray) => {
                        // Create a typecheck command and add it to the list
                        const typecheckCmd = ["npm", "run", pattern];
                        const commands = [...otherCommands, typecheckCmd];
                        const history = buildHistory(commands, statsArray);

                        const result = filterByIntensity(commands, "reduced", history);

                        // Should return exactly one command
                        expect(result.length).toBe(1);

                        // That command should be identified as a typecheck command
                        expect(isTypecheckCommand(result[0])).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('"reduced" falls back to full when no typecheck command exists', () => {
            // Generate commands that do NOT contain any typecheck pattern
            const arbNonTypecheckArg = fc
                .stringMatching(/^[a-z][a-z0-9]{0,11}$/)
                .filter((arg) => !TYPECHECK_PATTERNS.some((p) => arg.includes(p)));

            const arbNonTypecheckCommand = fc.array(arbNonTypecheckArg, {
                minLength: 1,
                maxLength: 4,
            });

            fc.assert(
                fc.property(
                    fc.array(arbNonTypecheckCommand, { minLength: 1, maxLength: 8 }),
                    fc.array(arbCommandStats, { minLength: 1, maxLength: 3 }),
                    (commands, statsArray) => {
                        // Verify none are typecheck commands
                        const hasTypecheck = commands.some(isTypecheckCommand);
                        if (hasTypecheck) return; // skip if accidentally generated one

                        const history = buildHistory(commands, statsArray);

                        const reducedResult = filterByIntensity(commands, "reduced", history);
                        const fullResult = filterByIntensity(commands, "full", history);

                        // Should be same as full
                        expect(reducedResult).toEqual(fullResult);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });

    /**
     * Property 12: Typecheck identification correctness
     *
     * For any command containing an argument that contains one of the known
     * typecheck patterns, isTypecheckCommand SHALL return true. For any command
     * where no argument contains any pattern, isTypecheckCommand SHALL return false.
     *
     * **Validates: Requirements 7.1, 7.2**
     */
    describe("Property 12: Typecheck identification correctness", () => {
        it("correctly identifies commands containing TYPECHECK_PATTERNS", () => {
            const arbTypecheckPattern = fc.constantFrom(...TYPECHECK_PATTERNS);

            fc.assert(
                fc.property(
                    fc.array(
                        fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
                        { minLength: 0, maxLength: 3 },
                    ),
                    arbTypecheckPattern,
                    fc.array(
                        fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
                        { minLength: 0, maxLength: 2 },
                    ),
                    (prefix, pattern, suffix) => {
                        // Command with the pattern as an argument
                        const command = [...prefix, pattern, ...suffix];
                        expect(isTypecheckCommand(command)).toBe(true);
                    },
                ),
                { numRuns: 200 },
            );
        });

        it("returns false for commands without any typecheck pattern", () => {
            const arbSafeArg = fc
                .stringMatching(/^[a-z][a-z0-9]{0,11}$/)
                .filter((arg) => !TYPECHECK_PATTERNS.some((p) => arg.includes(p)));

            fc.assert(
                fc.property(
                    fc.array(arbSafeArg, { minLength: 1, maxLength: 4 }),
                    (command) => {
                        expect(isTypecheckCommand(command)).toBe(false);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
