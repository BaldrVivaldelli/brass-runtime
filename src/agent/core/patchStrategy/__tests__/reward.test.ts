import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeReward } from "../reward";
import type { AgentState, Observation } from "../../types";

/**
 * Property-based tests for reward computation.
 * Feature: adaptive-patch-strategy
 */

/**
 * Build a minimal AgentState with specific observations for reward testing.
 */
const makeState = (overrides: {
    observations?: readonly Observation[];
    patchQuality?: { maxRepairAttempts?: number };
    validationCommands?: readonly string[];
}): AgentState => ({
    goal: {
        id: "test",
        cwd: "/tmp/test",
        text: "fix the bug",
        mode: "write",
        patchQuality: overrides.patchQuality
            ? { enabled: true, maxRepairAttempts: overrides.patchQuality.maxRepairAttempts ?? 1 }
            : undefined,
        project: overrides.validationCommands
            ? { validationCommands: overrides.validationCommands }
            : undefined,
    },
    phase: "done",
    observations: overrides.observations ?? [],
    errors: [],
    steps: 5,
});

describe("reward property tests", () => {
    /**
     * Property 10: Reward signal bounds
     *
     * For any final AgentState, computeReward returns a number in [0,1].
     * States with all validations passing yield 1.0, states with no patch or
     * failed patch yield 0.0, states with repair yield value in (0,1).
     *
     * Feature: adaptive-patch-strategy, Property 10: Reward signal bounds
     * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
     */
    describe("Property 10: Reward signal bounds", () => {
        it("computeReward always returns a value in [0, 1]", () => {
            // Arbitrary observations that can appear in a final state
            const arbObservations: fc.Arbitrary<readonly Observation[]> = fc.array(
                fc.oneof(
                    fc.record({
                        type: fc.constant("fs.fileRead" as const),
                        path: fc.constant("package.json"),
                        content: fc.constant('{"scripts":{"test":"vitest run"}}'),
                    }),
                    fc.record({
                        type: fc.constant("patch.applied" as const),
                        changedFiles: fc.constant(["src/index.ts"]),
                    }),
                    fc.record({
                        type: fc.constant("shell.result" as const),
                        command: fc.constant(["npm", "test"]),
                        exitCode: fc.oneof(fc.constant(0), fc.constant(1)),
                        stdout: fc.constant(""),
                        stderr: fc.constant(""),
                    }),
                    fc.record({
                        type: fc.constant("llm.response" as const),
                        purpose: fc.constant("patch" as const),
                        content: fc.constant("repair attempt"),
                    }),
                ),
                { minLength: 0, maxLength: 8 },
            );

            fc.assert(
                fc.property(arbObservations, (observations) => {
                    const state = makeState({
                        observations,
                        validationCommands: ["npm test"],
                        patchQuality: { maxRepairAttempts: 3 },
                    });
                    const reward = computeReward(state);
                    expect(reward).toBeGreaterThanOrEqual(0);
                    expect(reward).toBeLessThanOrEqual(1);
                }),
                { numRuns: 100 },
            );
        });

        it("states with no patch produced yield 0.0", () => {
            const state = makeState({
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"scripts":{"test":"vitest run"}}' },
                ],
                validationCommands: ["npm test"],
            });
            expect(computeReward(state)).toBe(0.0);
        });

        it("states with all validations passing yield 1.0", () => {
            const state = makeState({
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"scripts":{"test":"vitest run"}}' },
                    { type: "patch.applied", changedFiles: ["src/index.ts"] },
                    { type: "shell.result", command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" },
                ],
                validationCommands: ["npm test"],
            });
            expect(computeReward(state)).toBe(1.0);
        });

        it("states with failed validation and no repair yield 0.0", () => {
            const state = makeState({
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"scripts":{"test":"vitest run"}}' },
                    { type: "patch.applied", changedFiles: ["src/index.ts"] },
                    { type: "shell.result", command: ["npm", "test"], exitCode: 1, stdout: "", stderr: "fail" },
                ],
                validationCommands: ["npm test"],
            });
            expect(computeReward(state)).toBe(0.0);
        });

        it("states with repair yield value in (0, 1)", () => {
            const state = makeState({
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"scripts":{"test":"vitest run"}}' },
                    { type: "patch.applied", changedFiles: ["src/index.ts"] },
                    // One repair attempt used
                    { type: "llm.response", purpose: "patch", content: "repair" },
                    { type: "shell.result", command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" },
                ],
                validationCommands: ["npm test"],
                patchQuality: { maxRepairAttempts: 3 },
            });
            const reward = computeReward(state);
            expect(reward).toBeGreaterThan(0);
            expect(reward).toBeLessThan(1);
        });
    });
});
