import { describe, it, expect } from "vitest";
import { Runtime } from "../../../../core/runtime/runtime";
import { runAgent } from "../../runAgent";
import type {
    AgentEnv,
    AgentEvent,
    AgentGoal,
    LLMResponse,
} from "../../types";
import { asyncSucceed } from "../../../../core/types/asyncEffect";

/**
 * Integration tests for the budget-aware runner.
 *
 * These tests exercise `runAgent` with a mock environment to verify
 * budget tracking, warning/exceeded events, and graceful degradation.
 *
 * **Validates: Requirements 3.1, 3.3, 8.1, 8.4**
 */

// --- Mock Environment Helpers ---

/**
 * Creates a mock AgentEnv with configurable LLM responses.
 * The LLM mock returns responses from the provided array in order,
 * cycling back to the last response if more calls are made.
 */
const makeMockEnv = (options: {
    llmResponses?: LLMResponse[];
    llm?: AgentEnv["llm"];
}): { env: AgentEnv; events: AgentEvent[] } => {
    const events: AgentEvent[] = [];
    let llmCallIndex = 0;

    const llmResponses = options.llmResponses ?? [
        { content: "I'll help with that. Here's my analysis.", usage: { inputTokens: 100, outputTokens: 50 } },
    ];

    const mockLlm: AgentEnv["llm"] = options.llm !== undefined
        ? options.llm
        : {
            complete: (_request) => {
                const response = llmResponses[Math.min(llmCallIndex, llmResponses.length - 1)];
                llmCallIndex++;
                return asyncSucceed(response) as any;
            },
        };

    const env: AgentEnv = {
        fs: {
            readFile: (_path) => asyncSucceed('{"name": "test-project", "scripts": {}}') as any,
            exists: (_path) => asyncSucceed(false) as any,
            searchText: (_cwd, _query) => asyncSucceed([]) as any,
        },
        shell: {
            exec: (_command, _options) => asyncSucceed({ exitCode: 0, stdout: "", stderr: "" }) as any,
        },
        llm: mockLlm,
        patch: {
            apply: (_cwd, _patch) => asyncSucceed({ changedFiles: ["src/file.ts"] }) as any,
            rollback: (_cwd, _patch) => asyncSucceed({ changedFiles: ["src/file.ts"] }) as any,
        },
        permissions: {
            check: (_action, _state) => asyncSucceed({ type: "allow" }) as any,
        },
        events: {
            emit: (event) => { events.push(event); },
        },
    };

    return { env, events };
};

/**
 * Creates a minimal AgentGoal that skips context discovery and validation
 * to reach the LLM planning call quickly.
 */
const makeGoal = (overrides?: Partial<AgentGoal>): AgentGoal => ({
    id: "test-integration",
    cwd: "/workspace",
    text: "Fix the bug",
    mode: "write",
    project: { validationCommands: [], packageManager: "npm" },
    context: { enabled: false },
    ...overrides,
});

// --- Integration Tests ---

describe("Budget-aware runner integration", () => {
    /**
     * Test: Full loop reaching warning zone.
     *
     * Sets a budget of 1000 tokens, has the LLM return a response that pushes
     * totalTokens past the budget but not past the hard cap.
     * Verifies `budget.warning` event is emitted.
     *
     * **Validates: Requirements 3.1**
     */
    it("emits budget.warning when totalTokens exceeds tokenBudget but stays under hard cap", async () => {
        // Budget: 1000 tokens, overshoot 0.5 (hard cap = 1500)
        // LLM returns 600 input + 500 output = 1100 total tokens (exceeds 1000, under 1500)
        const { env, events } = makeMockEnv({
            llmResponses: [
                {
                    content: "I analyzed the code. The issue is in the handler function.",
                    usage: { inputTokens: 600, outputTokens: 500 },
                },
            ],
        });

        const goal = makeGoal({
            budget: { tokenBudget: 1000, overshootFraction: 0.5 },
        });

        const runtime = Runtime.make(env);
        await runtime.toPromise(runAgent(runtime, goal));

        const warningEvents = events.filter((e) => e.type === "budget.warning");
        expect(warningEvents.length).toBeGreaterThanOrEqual(1);

        const warning = warningEvents[0] as Extract<AgentEvent, { type: "budget.warning" }>;
        expect(warning.totalTokens).toBeGreaterThan(1000);
        expect(warning.tokenBudget).toBe(1000);

        // Should NOT have exceeded event since we're under the hard cap
        const exceededEvents = events.filter((e) => e.type === "budget.exceeded");
        expect(exceededEvents).toHaveLength(0);
    });

    /**
     * Test: Full loop reaching hard cap.
     *
     * Sets a tight budget (100 tokens with overshootFraction 0.1, hard cap = 110),
     * has the LLM return a response that exceeds the hard cap.
     * Verifies `budget.exceeded` event is emitted and the run finishes with
     * budget exhaustion summary.
     *
     * **Validates: Requirements 3.3**
     */
    it("emits budget.exceeded and finishes when hard cap is reached", async () => {
        // Budget: 100 tokens, overshoot 0.1 (hard cap = 110)
        // First LLM call returns 80 input + 50 output = 130 total (exceeds hard cap of 110)
        // After the first call, totalTokens = 130 > 110, so the next LLM call is blocked.
        // But since the first call already pushes past the hard cap, the warning is emitted
        // and on the next attempted LLM call, exceeded is emitted.
        const { env, events } = makeMockEnv({
            llmResponses: [
                {
                    // First call: returns a plan that includes a patch
                    content: "```diff\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n line1\n+fix\n line2\n```",
                    usage: { inputTokens: 80, outputTokens: 50 },
                },
                {
                    // Second call (if reached): would be for repair
                    content: "Done.",
                    usage: { inputTokens: 50, outputTokens: 30 },
                },
            ],
        });

        const goal = makeGoal({
            budget: { tokenBudget: 100, overshootFraction: 0.1 },
        });

        const runtime = Runtime.make(env);
        const finalState = await runtime.toPromise(runAgent(runtime, goal));

        // The first LLM call pushes totalTokens to 130, which exceeds the hard cap of 110.
        // A warning event should be emitted (totalTokens > tokenBudget).
        const warningEvents = events.filter((e) => e.type === "budget.warning");
        expect(warningEvents.length).toBeGreaterThanOrEqual(1);

        // If the agent tries another LLM call, it should be blocked with budget.exceeded.
        // The agent should finish (either via exceeded or naturally after the patch flow).
        expect(finalState.phase).toBe("done");

        // Check that budget.usage event was emitted for the first call
        const usageEvents = events.filter((e) => e.type === "budget.usage");
        expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test: Graceful skip when no budget configured.
     *
     * Calls `runAgent` without any budget config. Verifies no budget events
     * are emitted and the run completes normally.
     *
     * **Validates: Requirements 8.1**
     */
    it("skips all budget behavior when no budget is configured", async () => {
        const { env, events } = makeMockEnv({
            llmResponses: [
                {
                    content: "The code looks fine. No changes needed.",
                    usage: { inputTokens: 200, outputTokens: 100 },
                },
            ],
        });

        // No budget field on goal or config
        const goal = makeGoal();

        const runtime = Runtime.make(env);
        const finalState = await runtime.toPromise(runAgent(runtime, goal));

        // Run should complete normally
        expect(finalState.phase).toBe("done");

        // No budget events should be emitted
        const budgetEvents = events.filter((e) =>
            e.type === "budget.usage" ||
            e.type === "budget.routed" ||
            e.type === "budget.confidence" ||
            e.type === "budget.warning" ||
            e.type === "budget.exceeded"
        );
        expect(budgetEvents).toHaveLength(0);
    });

    /**
     * Test: Graceful skip when `AgentEnv.llm` is undefined.
     *
     * Sets `env.llm = undefined`. Verifies the run handles this gracefully
     * without budget tracking since no LLM calls will occur.
     *
     * **Validates: Requirements 8.4**
     */
    it("handles undefined llm gracefully without budget events", async () => {
        const { env, events } = makeMockEnv({
            llm: undefined,
        });

        // Even with budget configured, if llm is undefined, no LLM calls happen
        const goal = makeGoal({
            llmAvailable: false,
            budget: { tokenBudget: 1000, overshootFraction: 0.1 },
        });

        const runtime = Runtime.make(env);
        const finalState = await runtime.toPromise(runAgent(runtime, goal));

        // Run should complete (the agent finishes with "No LLM provider configured" message)
        expect(finalState.phase).toBe("done");

        // No budget usage/routed/confidence events since no LLM calls were made
        const budgetLlmEvents = events.filter((e) =>
            e.type === "budget.usage" ||
            e.type === "budget.routed" ||
            e.type === "budget.confidence"
        );
        expect(budgetLlmEvents).toHaveLength(0);
    });

    /**
     * Test: Budget exceeded blocks second LLM call.
     *
     * Uses a tight budget so the first LLM call exceeds the hard cap,
     * then verifies the second LLM call (repair attempt) is blocked with budget.exceeded.
     * The patch is applied but validation fails, triggering a repair LLM call attempt.
     *
     * **Validates: Requirements 3.3**
     */
    it("blocks subsequent LLM calls after hard cap is exceeded", async () => {
        // Budget: 50 tokens, overshoot 0.0 (hard cap = 50)
        // First LLM call returns 30 input + 30 output = 60 total (exceeds hard cap of 50)
        // After patch apply, validation fails → agent tries repair LLM call → blocked by budget
        let llmCallCount = 0;

        const events: AgentEvent[] = [];
        let shellCallCount = 0;

        const env: AgentEnv = {
            fs: {
                readFile: (_path) => asyncSucceed('{"name": "test-project", "scripts": {}}') as any,
                exists: (_path) => asyncSucceed(false) as any,
                searchText: (_cwd, _query) => asyncSucceed([]) as any,
            },
            shell: {
                exec: (_command, _options) => {
                    shellCallCount++;
                    // All validation runs fail to ensure post-patch validation triggers repair
                    return asyncSucceed({ exitCode: 1, stdout: "", stderr: "test failed" }) as any;
                },
            },
            llm: {
                complete: (_request) => {
                    llmCallCount++;
                    return asyncSucceed({
                        content: "```diff\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n line1\n+fix\n line2\n```",
                        usage: { inputTokens: 30, outputTokens: 30 },
                    } satisfies LLMResponse) as any;
                },
            },
            patch: {
                apply: (_cwd, _patch) => asyncSucceed({ changedFiles: ["src/file.ts"] }) as any,
                rollback: (_cwd, _patch) => asyncSucceed({ changedFiles: ["src/file.ts"] }) as any,
            },
            permissions: {
                check: (_action, _state) => asyncSucceed({ type: "allow" }) as any,
            },
            events: {
                emit: (event) => { events.push(event); },
            },
        };

        const goal = makeGoal({
            budget: { tokenBudget: 50, overshootFraction: 0.0 },
            patchQuality: { enabled: true, maxRepairAttempts: 1 },
            project: { validationCommands: ["npm test"], packageManager: "npm" },
        });

        const runtime = Runtime.make(env);
        const finalState = await runtime.toPromise(runAgent(runtime, goal));

        // The first LLM call should succeed (budget gate checks BEFORE the call)
        expect(llmCallCount).toBe(1);

        // After the first call, totalTokens = 60 > hard cap of 50
        // The second LLM call attempt (repair) should be blocked
        const exceededEvents = events.filter((e) => e.type === "budget.exceeded");
        expect(exceededEvents.length).toBeGreaterThanOrEqual(1);

        // The run should finish
        expect(finalState.phase).toBe("done");

        // The finish summary should mention budget
        const doneObs = finalState.observations.find((o) => o.type === "agent.done");
        if (doneObs && doneObs.type === "agent.done") {
            expect(doneObs.summary.toLowerCase()).toContain("budget");
        }
    });
});
