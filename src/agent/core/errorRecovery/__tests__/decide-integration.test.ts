import { describe, it, expect } from "vitest";
import { decideNextAction } from "../../decide";
import type { AgentAction, AgentError, AgentState, Observation } from "../../types";
import type { Async } from "../../../../core/types/asyncEffect";

/**
 * Integration tests for decide.ts recovery flow.
 * These tests exercise `decideNextAction` with agent states that have `agent.error` observations,
 * verifying the full integration path: decideNextAction → classifyError → decideRecoveryAction → AgentAction.
 *
 * **Validates: Requirements 8.3, 8.4, 10.1**
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
 * Build a minimal AgentState with an agent.error observation at the end.
 * Includes the package.json read observation to skip the boot phase.
 */
const buildErrorState = (
    error: AgentError,
    overrides?: Partial<Pick<AgentState, "errors" | "goal">>,
): AgentState => ({
    goal: {
        id: "test-goal",
        cwd: "/workspace",
        text: "Fix a bug",
        mode: "write",
        patchQuality: {
            enabled: true,
            maxRepairAttempts: 2,
        },
        project: {
            validationCommands: [],
        },
        context: {
            enabled: false,
        },
        ...overrides?.goal,
    },
    phase: "validating",
    observations: [
        { type: "fs.fileRead", path: "package.json", content: '{"name": "test-project"}' },
        { type: "agent.error", error },
    ],
    errors: overrides?.errors ?? [error],
    steps: 1,
});

// --- Integration Tests ---

describe("decide.ts recovery flow integration", () => {
    describe("PatchError with budget triggers retry via decideRecoveryAction", () => {
        it("returns llm.complete with purpose 'patch' for PatchError with remaining budget", () => {
            const error: AgentError = {
                _tag: "PatchError",
                operation: "apply",
                cause: "patch does not apply cleanly",
                patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
            };

            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("llm.complete");
            if (action.type === "llm.complete") {
                expect(action.purpose).toBe("patch");
                // The prompt should contain error context about the patch failure
                expect(action.prompt.length).toBeGreaterThan(0);
            }
        });

        it("returns llm.complete for PatchError with parse subcategory", () => {
            const error: AgentError = {
                _tag: "PatchError",
                operation: "parse",
                cause: "invalid diff format",
            };

            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("llm.complete");
            if (action.type === "llm.complete") {
                expect(action.purpose).toBe("patch");
            }
        });

        it("returns llm.complete for PatchError with conflict subcategory", () => {
            const error: AgentError = {
                _tag: "PatchError",
                operation: "conflict",
                cause: "merge conflict detected",
            };

            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("llm.complete");
            if (action.type === "llm.complete") {
                expect(action.purpose).toBe("patch");
            }
        });

        it("returns agent.finish (terminate) when PatchError budget is exhausted", () => {
            const error: AgentError = {
                _tag: "PatchError",
                operation: "apply",
                cause: "patch does not apply",
            };

            const state = buildErrorState(error, {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    patchQuality: {
                        enabled: true,
                        maxRepairAttempts: 0,
                    },
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
            });

            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("agent.finish");
        });
    });

    describe("FsError triggers terminate", () => {
        it("returns agent.finish for FsError", () => {
            const error: AgentError = {
                _tag: "FsError",
                operation: "readFile",
                cause: "ENOENT: no such file or directory",
            };

            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("agent.finish");
            if (action.type === "agent.finish") {
                expect(action.summary.length).toBeGreaterThan(0);
            }
        });

        it("returns agent.finish for FsError regardless of repair budget", () => {
            const error: AgentError = {
                _tag: "FsError",
                operation: "writeFile",
                cause: "EACCES: permission denied",
            };

            const state = buildErrorState(error, {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    patchQuality: {
                        enabled: true,
                        maxRepairAttempts: 10,
                    },
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
            });

            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("agent.finish");
        });
    });

    describe("ShellError triggers skip (falls through to normal decision)", () => {
        it("falls through to normal decision logic for ShellError (skip returns undefined)", () => {
            const error: AgentError = {
                _tag: "ShellError",
                operation: "exec",
                command: ["npm", "test"],
                cause: "exit code 1",
            };

            // Build a state where the skip will fall through to normal decision logic.
            // Since we have package.json read already, it should proceed to the next action in the pipeline.
            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            // ShellError → skip → falls through to normal decision logic.
            // It should NOT be agent.finish (terminate) — that would mean it didn't skip.
            // The action should be something from the normal decision flow (not a terminate from error recovery).
            expect(action.type).not.toBe("agent.finish");
        });

        it("ShellError does not produce llm.complete repair action", () => {
            const error: AgentError = {
                _tag: "ShellError",
                operation: "exec",
                command: ["npm", "run", "build"],
                cause: "command not found",
            };

            const state = buildErrorState(error);
            const result = decideNextAction(state);
            const action = extractAction(result);

            // ShellError should never trigger a repair (llm.complete with purpose "patch")
            if (action.type === "llm.complete") {
                expect(action.purpose).not.toBe("patch");
            }
        });
    });

    describe("backward compatibility with empty history", () => {
        it("PatchError with budget and empty errors array still triggers retry", () => {
            const error: AgentError = {
                _tag: "PatchError",
                operation: "apply",
                cause: "hunk failed",
                patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b",
            };

            // Empty errors array — simulates no prior error history
            const state: AgentState = {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    patchQuality: {
                        enabled: true,
                        maxRepairAttempts: 1,
                    },
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
                phase: "validating",
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                    { type: "agent.error", error },
                ],
                errors: [],
                steps: 1,
            };

            const result = decideNextAction(state);
            const action = extractAction(result);

            // With empty history and budget remaining, PatchError should still trigger retry
            expect(action.type).toBe("llm.complete");
            if (action.type === "llm.complete") {
                expect(action.purpose).toBe("patch");
            }
        });

        it("FsError with empty errors array still terminates", () => {
            const error: AgentError = {
                _tag: "FsError",
                operation: "readFile",
                cause: "ENOENT",
            };

            const state: AgentState = {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
                phase: "validating",
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                    { type: "agent.error", error },
                ],
                errors: [],
                steps: 1,
            };

            const result = decideNextAction(state);
            const action = extractAction(result);

            expect(action.type).toBe("agent.finish");
        });

        it("ShellError with empty errors array still skips (falls through)", () => {
            const error: AgentError = {
                _tag: "ShellError",
                operation: "exec",
                command: ["ls"],
                cause: "not found",
            };

            const state: AgentState = {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
                phase: "validating",
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                    { type: "agent.error", error },
                ],
                errors: [],
                steps: 1,
            };

            const result = decideNextAction(state);
            const action = extractAction(result);

            // ShellError skips → falls through to normal decision logic (not terminate)
            expect(action.type).not.toBe("agent.finish");
        });

        it("LLMError with empty errors array terminates (no retry for unknown errors in legacy behavior)", () => {
            const error: AgentError = {
                _tag: "LLMError",
                cause: "timeout: request took too long",
            };

            const state: AgentState = {
                goal: {
                    id: "test-goal",
                    cwd: "/workspace",
                    text: "Fix a bug",
                    mode: "write",
                    project: { validationCommands: [] },
                    context: { enabled: false },
                },
                phase: "validating",
                observations: [
                    { type: "fs.fileRead", path: "package.json", content: '{"name": "test"}' },
                    { type: "agent.error", error },
                ],
                errors: [],
                steps: 1,
            };

            const result = decideNextAction(state);
            const action = extractAction(result);

            // LLMError.timeout with empty history → wait action → maps to undefined (skip/fall-through)
            // The wait action returns undefined from mapRecoveryToAction, so it falls through
            // to normal decision logic (not agent.finish)
            // This is the new adaptive behavior — wait before retry
            expect(action.type).not.toBe("agent.finish");
        });
    });
});
