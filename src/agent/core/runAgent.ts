import { asyncFail, asyncFold, asyncFlatMap, asyncSucceed, asyncSync, asyncInterruptible, type Async } from "../../core/types/asyncEffect";
import type { Runtime } from "../../core/runtime/runtime";
import type { Scope } from "../../core/runtime/scope";
import { withScopeAsync } from "../../core/runtime/scope";
import type { AgentAction, AgentEnv, AgentError, AgentGoal, AgentState, LLMResponse, Observation } from "./types";
import { decideNextAction } from "./decide";
import { initialAgentState } from "./state";
import { isTerminal, reduceAgentState } from "./reducer";
import { invokeAction } from "../tools/policy";
import {
    emitAgentEvent,
    emitAgentEvents,
    errorEventFor,
    nowMillis,
    observationEventFor,
    runStatusFor,
} from "./events";
import type { BudgetConfig, BudgetConfigInput, BudgetState, TokenUsage } from "./llmBudget/types";
import { resolveBudgetConfig, validateBudgetConfig } from "./llmBudget/config";
import { budgetAllowsCall, initBudgetState, updateBudgetState } from "./llmBudget/state";
import { estimateTokens } from "./llmBudget/estimation";
import { estimateConfidence } from "./llmBudget/confidence";
import { extractComplexitySignals, routeModel } from "./llmBudget/router";
import {
    makeBudgetConfidenceEvent,
    makeBudgetExceededEvent,
    makeBudgetRoutedEvent,
    makeBudgetUsageEvent,
    makeBudgetWarningEvent,
} from "./llmBudget/events";
import { appendRunRecord, parseLearningStore, serializeLearningStore } from "./llmBudget/persistence";
import type { LearningRunRecord } from "./llmBudget/persistence";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const executeAction = (
    action: AgentAction,
    state: AgentState,
    scope: Scope<AgentEnv>
): Async<AgentEnv, AgentError, Observation> =>
    asyncFlatMap(nowMillis() as any, (startedAt: number) =>
        asyncFlatMap(
            emitAgentEvent({
                type: "agent.action.started",
                action,
                step: state.steps + 1,
                phase: state.phase,
                at: startedAt,
            }) as any,
            () =>
                asyncFold(
                    invokeAction(action, state, scope) as any,
                    (error: AgentError) =>
                        asyncFlatMap(nowMillis() as any, (endedAt: number) => {
                            const specific = errorEventFor(action, state, error, endedAt);
                            const events = [
                                ...(specific ? [specific] : []),
                                {
                                    type: "agent.action.failed" as const,
                                    action,
                                    error,
                                    step: state.steps + 1,
                                    phase: state.phase,
                                    durationMs: endedAt - startedAt,
                                    at: endedAt,
                                },
                            ];

                            return asyncFlatMap(
                                emitAgentEvents(events) as any,
                                () => asyncSucceed({ type: "agent.error", error } satisfies Observation) as any
                            ) as any;
                        }) as any,
                    (observation: Observation) =>
                        asyncFlatMap(nowMillis() as any, (endedAt: number) =>
                            asyncFlatMap(
                                emitAgentEvent({
                                    type: "agent.action.completed",
                                    action,
                                    observation,
                                    step: state.steps + 1,
                                    phase: state.phase,
                                    durationMs: endedAt - startedAt,
                                    at: endedAt,
                                }) as any,
                                () => asyncSucceed(observation) as any
                            ) as any
                        ) as any
                ) as any
        ) as any
    ) as any;

const recordObservation = (next: AgentState, observation: Observation): Async<AgentEnv, never, void> =>
    asyncFlatMap(nowMillis() as any, (at: number) => {
        const specific = observationEventFor(next, observation, at);
        const events = [
            {
                type: "agent.observation.recorded" as const,
                observation,
                step: next.steps,
                phase: next.phase,
                at,
            },
            ...(specific ? [specific] : []),
        ];

        return emitAgentEvents(events) as any;
    }) as any;

/**
 * Builds a summary message when the budget is exhausted.
 * Includes phase-specific messaging per Requirements 3.5 and 3.6.
 */
const buildBudgetExhaustedSummary = (state: AgentState): string => {
    const observations = state.observations;
    const fileReads = observations.filter((o) => o.type === "fs.fileRead").length;
    const llmCalls = observations.filter((o) => o.type === "llm.response").length;

    // Requirement 3.5: planning phase with no plan produced
    if (state.phase === "planning") {
        const hasPlan = observations.some((o) => o.type === "llm.response");
        if (!hasPlan) {
            return "Budget exhausted before planning could complete. No plan was generated within the token budget.";
        }
    }

    // Requirement 3.6: validating phase — non-LLM commands are allowed to complete
    // (the budget gate only blocks llm.complete, so non-LLM actions naturally finish)
    if (state.phase === "validating") {
        return `Budget exhausted during validation. Completed ${state.steps} steps (${fileReads} file reads, ${llmCalls} LLM calls). In-progress non-LLM validation commands were allowed to complete.`;
    }

    return `Budget exhausted. Completed ${state.steps} steps (${fileReads} file reads, ${llmCalls} LLM calls) before reaching the token budget hard cap.`;
};

/**
 * Extracts file paths from fs.fileRead observations for confidence estimation.
 */
const extractReadFiles = (state: AgentState): readonly string[] =>
    state.observations
        .filter((o): o is Extract<typeof o, { type: "fs.fileRead" }> => o.type === "fs.fileRead")
        .map((o) => o.path);

/** Path for the learning store file relative to cwd. */
const LEARNING_STORE_PATH = ".brass/llm-budget.json";

/**
 * Persists a learning record to `.brass/llm-budget.json` on run completion.
 * Reads existing file, appends the record, and writes back.
 * Creates the file with empty structure if it doesn't exist.
 * Never throws — catches all errors and logs a warning.
 */
const persistLearningRecord = (
    state: AgentState,
    budgetState: BudgetState,
): Async<AgentEnv, never, void> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, void>((_env, cb) => {
            const filePath = `${state.goal.cwd}/${LEARNING_STORE_PATH}`;

            const run = async () => {
                // Build the learning record from the final budget state
                const lastCall = budgetState.calls[budgetState.calls.length - 1];
                const tier = lastCall?.tier ?? "small";

                // Compute average confidence across all calls
                const confidence = budgetState.callCount > 0
                    ? budgetState.calls.reduce((sum, c) => sum + c.confidence, 0) / budgetState.callCount
                    : 0;

                const record: LearningRunRecord = {
                    goalId: state.goal.id,
                    totalTokens: budgetState.totalTokens,
                    callCount: budgetState.callCount,
                    tier,
                    confidence,
                    timestamp: Date.now(),
                };

                // Read existing file (returns empty string on missing file)
                let existingJson = "";
                try {
                    existingJson = await readFile(filePath, "utf8");
                } catch {
                    // File doesn't exist — will create with empty structure
                }

                // Parse, append, serialize
                const store = parseLearningStore(existingJson);
                const updated = appendRunRecord(store, record);
                const serialized = serializeLearningStore(updated);

                // Ensure directory exists and write
                await mkdir(dirname(filePath), { recursive: true });
                await writeFile(filePath, serialized, "utf8");
            };

            run().then(
                () => cb({ _tag: "Success", value: undefined }),
                (err) => cb({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "FsError", operation: "persistLearningStore", cause: err } as AgentError } }),
            );
        }),
        // On failure: swallow the error silently (Requirement 7.4)
        () => asyncSucceed(undefined as void) as any,
        // On success: pass through
        () => asyncSucceed(undefined as void) as any,
    ) as Async<AgentEnv, never, void>;

/**
 * Handles the budget gate for llm.complete actions. Returns the updated budget state
 * alongside the observation, or substitutes with agent.finish when exceeded.
 */
const executeBudgetGatedLLMCall = (
    action: Extract<AgentAction, { type: "llm.complete" }>,
    state: AgentState,
    budgetState: BudgetState,
    budgetConfig: BudgetConfig,
    scope: Scope<AgentEnv>,
): Async<AgentEnv, AgentError, { observation: Observation; budgetState: BudgetState }> => {
    // Check if budget allows the call
    if (!budgetAllowsCall(budgetState, budgetConfig)) {
        // Budget exceeded: emit exceeded event, substitute with agent.finish
        const hardCap = budgetConfig.tokenBudget * (1 + budgetConfig.overshootFraction);
        const exceededEvent = makeBudgetExceededEvent(
            budgetState.totalTokens,
            budgetConfig.tokenBudget,
            budgetConfig.overshootFraction,
            hardCap,
        );

        return asyncFlatMap(emitAgentEvent(exceededEvent) as any, () => {
            const finishObservation: Observation = {
                type: "agent.done",
                summary: buildBudgetExhaustedSummary(state),
            };
            return asyncSucceed({ observation: finishObservation, budgetState }) as any;
        }) as any;
    }

    // Budget allows: route model and emit routed event
    const tier = routeModel(state, budgetState);
    const signals = extractComplexitySignals(state);
    const resolvedProvider = budgetConfig.modelTiers?.[tier]?.provider;
    const routedEvent = makeBudgetRoutedEvent(tier, signals, resolvedProvider);

    return asyncFlatMap(emitAgentEvent(routedEvent) as any, () =>
        // Execute the LLM call through the normal action execution path
        // We use the LLM service directly to capture the full LLMResponse with usage
        asyncFlatMap(asyncSync((env: AgentEnv) => env.llm) as any, (llm: AgentEnv["llm"]) => {
            if (!llm) {
                return asyncFail({
                    _tag: "LLMError",
                    cause: "llm_unavailable: no LLM provider is configured",
                } satisfies AgentError) as any;
            }

            return asyncFlatMap(
                llm.complete({ purpose: action.purpose, prompt: action.prompt }) as any,
                (response: LLMResponse) => {
                    // Determine token usage: use reported usage or estimate from character lengths
                    const usage: TokenUsage = response.usage ?? estimateTokens(
                        action.prompt.length,
                        response.content.length,
                    );
                    const estimated = response.usage === undefined;

                    // Estimate confidence
                    const readFiles = extractReadFiles(state);
                    const { score: confidence, signals: confidenceSignals } = estimateConfidence(
                        response.content,
                        state.goal.text,
                        readFiles,
                    );

                    // Update budget state
                    const newBudgetState = updateBudgetState(budgetState, usage, tier, confidence, estimated);

                    // Build events to emit
                    const remaining = Math.max(0, budgetConfig.tokenBudget - newBudgetState.totalTokens);
                    const usageEvent = makeBudgetUsageEvent(
                        usage,
                        { totalTokens: newBudgetState.totalTokens, callCount: newBudgetState.callCount },
                        tier,
                        remaining,
                    );
                    const confidenceEvent = makeBudgetConfidenceEvent(confidence, confidenceSignals, action.purpose);

                    const events = [usageEvent, confidenceEvent];

                    // Emit warning if totalTokens > tokenBudget after update
                    if (newBudgetState.totalTokens > budgetConfig.tokenBudget) {
                        events.push(makeBudgetWarningEvent(newBudgetState.totalTokens, budgetConfig.tokenBudget));
                    }

                    return asyncFlatMap(emitAgentEvents(events) as any, () => {
                        const observation: Observation = {
                            type: "llm.response",
                            purpose: action.purpose,
                            content: response.content,
                        };
                        return asyncSucceed({ observation, budgetState: newBudgetState }) as any;
                    }) as any;
                },
            ) as any;
        }) as any,
    ) as any;
};

const runLoop = (
    state: AgentState,
    budgetState: BudgetState | undefined,
    budgetConfig: BudgetConfig | undefined,
    scope: Scope<AgentEnv>,
    runStartedAt: number
): Async<AgentEnv, AgentError, AgentState> => {
    if (isTerminal(state)) {
        // Persist learning record when budget was active
        const persistEffect: Async<AgentEnv, never, void> =
            budgetConfig !== undefined && budgetState !== undefined
                ? persistLearningRecord(state, budgetState)
                : asyncSucceed(undefined as void) as any;

        return asyncFlatMap(persistEffect as any, () =>
            asyncFlatMap(nowMillis() as any, (at: number) =>
                asyncFlatMap(
                    emitAgentEvent({
                        type: "agent.run.completed",
                        goal: state.goal,
                        status: runStatusFor(state.phase),
                        phase: state.phase,
                        steps: state.steps,
                        durationMs: at - runStartedAt,
                        at,
                    }) as any,
                    () => asyncSucceed(state) as any
                ) as any
            ) as any
        ) as any;
    }

    return asyncFlatMap(decideNextAction(state) as any, (action: AgentAction) => {
        // Budget gate: intercept llm.complete actions when budget is configured
        if (action.type === "llm.complete" && budgetConfig !== undefined && budgetState !== undefined) {
            return asyncFlatMap(
                executeBudgetGatedLLMCall(action, state, budgetState, budgetConfig, scope) as any,
                (result: { observation: Observation; budgetState: BudgetState }) => {
                    const next = reduceAgentState(state, result.observation);

                    return asyncFlatMap(recordObservation(next, result.observation) as any, () =>
                        runLoop(next, result.budgetState, budgetConfig, scope, runStartedAt) as any
                    ) as any;
                },
            ) as any;
        }

        // Non-LLM actions (or no budget configured): execute normally
        return asyncFlatMap(executeAction(action, state, scope) as any, (observation: Observation) => {
            const next = reduceAgentState(state, observation);

            return asyncFlatMap(recordObservation(next, observation) as any, () =>
                runLoop(next, budgetState, budgetConfig, scope, runStartedAt) as any
            ) as any;
        }) as any;
    }) as any;
};

export const runAgent = (
    runtime: Runtime<AgentEnv>,
    goal: AgentGoal,
    configBudget?: BudgetConfigInput
): Async<AgentEnv, AgentError, AgentState> => {
    // Resolve budget configuration: goal budget overrides config budget
    const budgetConfig = resolveBudgetConfig(goal.budget, configBudget);

    // Validate budget config at construction time if present
    if (budgetConfig !== undefined) {
        const validationError = validateBudgetConfig(budgetConfig);
        if (validationError !== undefined) {
            return asyncFail({ _tag: "AgentLoopError", message: validationError } as AgentError);
        }
    }

    // Initialize budget state when config is present
    const budgetState = budgetConfig !== undefined ? initBudgetState() : undefined;

    return withScopeAsync(runtime, (scope) =>
        asyncFlatMap(nowMillis() as any, (startedAt: number) =>
            asyncFlatMap(
                emitAgentEvent({ type: "agent.run.started", goal, at: startedAt }) as any,
                () => runLoop(initialAgentState(goal), budgetState, budgetConfig, scope as Scope<AgentEnv>, startedAt) as any
            ) as any
        ) as any
    );
};
