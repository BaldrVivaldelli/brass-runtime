import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { decideNextAction } from "../decide";
import type { AgentAction, AgentError, AgentGoal, AgentMode, AgentState, Observation } from "../types";
import type { Async } from "../../../core/types/asyncEffect";

/**
 * Property-based tests for patch flow without LLM.
 * Feature: agent-host-llm-refactor, Property 10: Patch flow without LLM completes without LLM actions
 *
 * For any AgentGoal with a non-empty initialPatch and an AgentEnv where llm is undefined,
 * the decision engine SHALL produce a sequence of actions that reaches agent.finish without
 * ever emitting an llm.complete action. If the patch operation fails with a PatchError,
 * the decision engine SHALL terminate with agent.finish rather than attempting an
 * llm.complete repair action.
 *
 * **Validates: Requirements 10.2, 10.5**
 */

// --- Helpers ---

/**
 * Extract the action value from a decideNextAction result.
 * decideNextAction always returns asyncSucceed(action), so the result is { _tag: "Succeed", value: action }.
 */
const extractAction = (result: Async<any, any, AgentAction>): AgentAction => {
    if (result._tag !== "Succeed") {
        throw new Error(`Expected Succeed but got ${result._tag}`);
    }
    return result.value;
};

/**
 * Simulate the agent loop by calling decideNextAction repeatedly,
 * providing synthetic observations for each action until agent.finish is reached.
 * Returns the sequence of actions produced.
 */
const simulateLoop = (
    initialState: AgentState,
    maxSteps: number = 50,
): readonly AgentAction[] => {
    const actions: AgentAction[] = [];
    let state = initialState;

    for (let step = 0; step < maxSteps; step++) {
        const result = decideNextAction(state);
        const action = extractAction(result);
        actions.push(action);

        if (action.type === "agent.finish" || action.type === "agent.fail") {
            return actions;
        }

        // Simulate observations for each action type
        const observation = simulateObservation(action, state);
        state = {
            ...state,
            observations: [...state.observations, observation],
            steps: state.steps + 1,
        };
    }

    return actions;
};

/**
 * Simulate an observation for a given action.
 * For patch flow testing, we simulate successful outcomes for tool actions.
 */
const simulateObservation = (action: AgentAction, _state: AgentState): Observation => {
    switch (action.type) {
        case "fs.readFile":
            return { type: "fs.fileRead", path: action.path, content: '{"name": "test-project"}' };
        case "fs.exists":
            return { type: "fs.exists", path: action.path, exists: false };
        case "fs.searchText":
            return { type: "fs.searchResult", query: action.query, matches: [] };
        case "shell.exec":
            return { type: "shell.result", command: action.command, exitCode: 0, stdout: "", stderr: "" };
        case "patch.apply":
            return { type: "patch.applied", changedFiles: ["src/file.ts"], patch: action.patch };
        case "patch.propose":
            return { type: "patch.proposed", patch: action.patch };
        case "patch.rollback":
            return { type: "patch.rolledBack", changedFiles: ["src/file.ts"], patch: action.patch };
        case "llm.complete":
            // This should never be reached in our tests, but provide a response just in case
            return { type: "llm.response", purpose: action.purpose, content: "unexpected" };
        case "agent.finish":
        case "agent.fail":
            return { type: "agent.done", summary: "done" };
    }
};

// --- Arbitraries ---

/** Arbitrary for a non-empty unified diff string. */
const arbUnifiedDiff: fc.Arbitrary<string> = fc.tuple(
    fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }),
).map(([filename, content]) =>
    [
        `--- a/${filename}`,
        `+++ b/${filename}`,
        "@@ -1,3 +1,4 @@",
        " line1",
        "+added line",
        ` ${content.slice(0, 50)}`,
        " line3",
    ].join("\n"),
);

/** Arbitrary for writable agent modes (write or autonomous). */
const arbWritableMode: fc.Arbitrary<AgentMode> = fc.constantFrom("write" as AgentMode, "autonomous" as AgentMode);

/** Arbitrary for propose mode. */
const arbProposeMode: fc.Arbitrary<AgentMode> = fc.constant("propose" as AgentMode);

/** Arbitrary for any mode that supports patch flow. */
const arbPatchMode: fc.Arbitrary<AgentMode> = fc.constantFrom(
    "write" as AgentMode,
    "autonomous" as AgentMode,
    "propose" as AgentMode,
);

/**
 * Build a minimal AgentState with initialPatch and llmAvailable=false.
 * Includes the package.json read observation and lockfile probes to skip
 * the boot phase and go directly to the patch flow.
 */
const buildPatchFlowState = (patch: string, mode: AgentMode): AgentState => ({
    goal: {
        id: "test-goal",
        cwd: "/workspace",
        text: "Apply patch",
        mode,
        initialPatch: patch,
        llmAvailable: false,
        project: {
            validationCommands: [],
        },
        context: {
            enabled: false,
        },
    },
    phase: "boot",
    observations: [
        // Pre-populate package.json read to skip the boot fs.readFile step
        { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
    ],
    errors: [],
    steps: 0,
});

// --- Property 10: Patch flow without LLM completes without LLM actions ---

describe("Property 10: Patch flow without LLM completes without LLM actions", () => {
    /**
     * Feature: agent-host-llm-refactor, Property 10: Patch flow without LLM completes without LLM actions
     *
     * For any AgentGoal with a non-empty initialPatch and llmAvailable=false in write/autonomous mode,
     * the decision engine SHALL produce a sequence of actions that reaches agent.finish
     * without ever emitting an llm.complete action.
     *
     * **Validates: Requirements 10.2, 10.5**
     */
    it("patch flow in writable mode never emits llm.complete and reaches agent.finish", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, arbWritableMode, (patch, mode) => {
                const state = buildPatchFlowState(patch, mode);
                const actions = simulateLoop(state);

                // Should never emit llm.complete
                const llmActions = actions.filter((a) => a.type === "llm.complete");
                expect(llmActions).toHaveLength(0);

                // Should reach agent.finish
                const lastAction = actions[actions.length - 1];
                expect(lastAction?.type).toBe("agent.finish");
            }),
            { numRuns: 100 },
        );
    });

    /**
     * For any AgentGoal with a non-empty initialPatch and llmAvailable=false in propose mode,
     * the decision engine SHALL produce a sequence of actions that reaches agent.finish
     * without ever emitting an llm.complete action.
     *
     * **Validates: Requirements 10.2**
     */
    it("patch flow in propose mode never emits llm.complete and reaches agent.finish", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, (patch) => {
                const state = buildPatchFlowState(patch, "propose");
                const actions = simulateLoop(state);

                // Should never emit llm.complete
                const llmActions = actions.filter((a) => a.type === "llm.complete");
                expect(llmActions).toHaveLength(0);

                // Should reach agent.finish
                const lastAction = actions[actions.length - 1];
                expect(lastAction?.type).toBe("agent.finish");
            }),
            { numRuns: 100 },
        );
    });

    /**
     * When a patch operation fails with a PatchError and llmAvailable=false,
     * the decision engine SHALL terminate with agent.finish rather than
     * attempting an llm.complete repair action.
     *
     * **Validates: Requirements 10.5**
     */
    it("PatchError with no LLM terminates with agent.finish, not llm.complete repair", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, arbWritableMode, (patch, mode) => {
                // Build state where a patch.apply was attempted and failed with PatchError
                const state: AgentState = {
                    ...buildPatchFlowState(patch, mode),
                    observations: [
                        { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                        {
                            type: "agent.error",
                            error: {
                                _tag: "PatchError",
                                operation: "apply",
                                cause: "patch does not apply cleanly",
                                patch,
                            },
                        },
                    ],
                };

                const result = decideNextAction(state);
                const action = extractAction(result);

                // Should be agent.finish, NOT llm.complete
                expect(action.type).toBe("agent.finish");
                expect(action.type).not.toBe("llm.complete");
            }),
            { numRuns: 100 },
        );
    });

    /**
     * When a patch rollback fails with a PatchError and llmAvailable=false,
     * the decision engine SHALL terminate with agent.finish.
     *
     * **Validates: Requirements 10.5**
     */
    it("PatchError during rollback with no LLM terminates with agent.finish", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, arbWritableMode, (patch, mode) => {
                const goal: AgentGoal = {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Rollback patch",
                    mode,
                    initialPatch: patch,
                    initialPatchMode: "rollback",
                    llmAvailable: false,
                    project: { validationCommands: [] },
                    context: { enabled: false },
                };

                const state: AgentState = {
                    goal,
                    phase: "boot",
                    observations: [
                        { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                        {
                            type: "agent.error",
                            error: {
                                _tag: "PatchError",
                                operation: "rollback",
                                cause: "rollback failed",
                                patch,
                            },
                        },
                    ],
                    errors: [],
                    steps: 1,
                };

                const result = decideNextAction(state);
                const action = extractAction(result);

                expect(action.type).toBe("agent.finish");
                expect(action.type).not.toBe("llm.complete");
            }),
            { numRuns: 100 },
        );
    });

    /**
     * The agent.finish summary after PatchError without LLM contains
     * meaningful error information (not empty).
     *
     * **Validates: Requirements 10.5**
     */
    it("agent.finish summary after PatchError contains error information", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, arbWritableMode, (patch, mode) => {
                const state: AgentState = {
                    ...buildPatchFlowState(patch, mode),
                    observations: [
                        { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                        {
                            type: "agent.error",
                            error: {
                                _tag: "PatchError",
                                operation: "apply",
                                cause: "hunk failed to apply",
                                patch,
                            },
                        },
                    ],
                };

                const result = decideNextAction(state);
                const action = extractAction(result);

                expect(action.type).toBe("agent.finish");
                if (action.type === "agent.finish") {
                    expect(action.summary.length).toBeGreaterThan(0);
                    // Summary should mention patch error
                    expect(action.summary.toLowerCase()).toContain("patch");
                }
            }),
            { numRuns: 100 },
        );
    });

    /**
     * For any patch mode (write, autonomous, propose), the full simulated loop
     * with a successful patch never emits llm.complete.
     *
     * **Validates: Requirements 10.2**
     */
    it("full loop with any patch mode never emits llm.complete", () => {
        fc.assert(
            fc.property(arbUnifiedDiff, arbPatchMode, (patch, mode) => {
                const state = buildPatchFlowState(patch, mode);
                const actions = simulateLoop(state);

                const llmActions = actions.filter((a) => a.type === "llm.complete");
                expect(llmActions).toHaveLength(0);

                const lastAction = actions[actions.length - 1];
                expect(lastAction?.type).toBe("agent.finish");
            }),
            { numRuns: 100 },
        );
    });
});
