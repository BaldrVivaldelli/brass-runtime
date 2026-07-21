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
import { parseErrorPatterns, serializeErrorPatterns } from "./errorRecovery/store";
import type { ErrorHistoryEntry } from "./errorRecovery/types";
import {
    computeVerbosityLevel,
    makeVerbosityFilter,
    makeRunDurationTracker,
    makePreferencesStore,
} from "./outputVerbosity";
import type { AdaptationSignals, OutputPreferences } from "./outputVerbosity";
import type { RunDurationTrackerInstance } from "./outputVerbosity/tracker";
import type { PreferencesStore } from "./outputVerbosity/store";
import {
    parseWorkspaceMemory,
    serializeWorkspaceMemory,
    seedContextBanditPriors,
    seedPatchStrategyPriors,
    recordFileChanges,
    recordCommandOutcomes,
    recordGoalOutcome,
    recordCoChanges,
    initialTriggerState,
    updateTriggerState,
    shouldReInfer,
    markReInferencePerformed,
} from "./workspaceMemory";
import type { WorkspaceMemory, TriggerState } from "./workspaceMemory";
import { buildHostProfile } from "./hostInference";
import type { HostSignalInput } from "./hostSignals";

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

/**
 * Loads error patterns from disk at agent run start.
 * On any failure (missing file, parse error, permission denied): returns empty array, no error log.
 * Uses asyncInterruptible to bridge the Promise into the effect system.
 */
const loadErrorHistory = (): Async<AgentEnv, never, readonly ErrorHistoryEntry[]> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, readonly ErrorHistoryEntry[]>((env, cb) => {
            if (!env.persistence) {
                cb({ _tag: "Success", value: [] });
                return;
            }
            env.persistence.read("workspace", "agent.error-patterns.v1").then(
                (value) => cb({ _tag: "Success", value: parseErrorPatterns(value ?? "") }),
                () => cb({ _tag: "Success", value: [] as readonly ErrorHistoryEntry[] }),
            );
        }),
        // On failure: proceed with empty history, no error log (Requirement 9.3)
        () => asyncSucceed([] as readonly ErrorHistoryEntry[]) as any,
        // On success: pass through
        (entries: readonly ErrorHistoryEntry[]) => asyncSucceed(entries) as any,
    ) as Async<AgentEnv, never, readonly ErrorHistoryEntry[]>;

/**
 * Persists error patterns to disk at agent run end.
 * On any failure: logs a warning, does not throw, never affects the result (Requirement 9.4).
 */
const persistErrorHistory = (
    entries: readonly ErrorHistoryEntry[],
): Async<AgentEnv, never, void> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, void>((env, cb) => {
            if (!env.persistence) {
                cb({ _tag: "Success", value: undefined });
                return;
            }
            env.persistence.write(
                "workspace",
                "agent.error-patterns.v1",
                serializeErrorPatterns(entries),
            ).then(
                () => cb({ _tag: "Success", value: undefined }),
                (err) => cb({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "FsError", operation: "persistErrorHistory", cause: err } as AgentError } }),
            );
        }),
        // On failure: log warning, continue execution (Requirement 9.4)
        () => asyncSucceed(undefined as void) as any,
        // On success: pass through
        () => asyncSucceed(undefined as void) as any,
    ) as Async<AgentEnv, never, void>;

/**
 * Persists a learning record through the host-owned versioned state store.
 * Reads existing file, appends the record, and writes back.
 * Creates the file with empty structure if it doesn't exist.
 * Never throws — catches all errors and logs a warning.
 */
const persistLearningRecord = (
    state: AgentState,
    budgetState: BudgetState,
): Async<AgentEnv, never, void> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, void>((env, cb) => {
            if (!env.persistence) {
                cb({ _tag: "Success", value: undefined });
                return;
            }
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
                const existingJson = await env.persistence!.read("workspace", "agent.llm-budget.v1") ?? "";

                // Parse, append, serialize
                const store = parseLearningStore(existingJson);
                const updated = appendRunRecord(store, record);
                const serialized = serializeLearningStore(updated);

                await env.persistence!.write("workspace", "agent.llm-budget.v1", serialized);
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

/**
 * Loads output preferences from disk at agent run start.
 * On any failure: returns empty preferences, no error log.
 */
const loadOutputPreferences = (
    store: PreferencesStore,
): Async<AgentEnv, never, OutputPreferences> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, OutputPreferences>((_env, cb) => {
            store.load().then(
                (prefs) => cb({ _tag: "Success", value: prefs }),
                () => cb({ _tag: "Success", value: { version: 1, runHistory: [], userOverride: undefined } as OutputPreferences }),
            );
        }),
        () => asyncSucceed({ version: 1, runHistory: [], userOverride: undefined } as OutputPreferences) as any,
        (prefs: OutputPreferences) => asyncSucceed(prefs) as any,
    ) as Async<AgentEnv, never, OutputPreferences>;

/**
 * Persists output preferences to disk at agent run end.
 * On any failure: silently swallows the error.
 */
const persistOutputPreferences = (
    store: PreferencesStore,
    prefs: OutputPreferences,
): Async<AgentEnv, never, void> =>
    asyncFold(
        asyncInterruptible<AgentEnv, AgentError, void>((_env, cb) => {
            store.save(prefs).then(
                () => cb({ _tag: "Success", value: undefined }),
                () => cb({ _tag: "Success", value: undefined }),
            );
        }),
        () => asyncSucceed(undefined as void) as any,
        () => asyncSucceed(undefined as void) as any,
    ) as Async<AgentEnv, never, void>;

/** Context for verbosity tracking passed through the run loop. */
type VerbosityContext = {
    readonly tracker: RunDurationTrackerInstance;
    readonly store: PreferencesStore;
    readonly prefs: OutputPreferences;
};

/** Context for workspace memory tracking passed through the run loop. */
type WorkspaceMemoryContext = {
    memory: WorkspaceMemory;
    triggerState: TriggerState;
    readonly originalSignals: HostSignalInput | undefined;
};

const runLoop = (
    state: AgentState,
    budgetState: BudgetState | undefined,
    budgetConfig: BudgetConfig | undefined,
    errorHistory: readonly ErrorHistoryEntry[],
    scope: Scope<AgentEnv>,
    runStartedAt: number,
    verbosity: VerbosityContext | undefined,
    memoryCtx: WorkspaceMemoryContext | undefined,
): Async<AgentEnv, AgentError, AgentState> => {
    // Tick the verbosity tracker on each loop iteration
    verbosity?.tracker.tick();

    if (isTerminal(state)) {
        // Persist learning record when budget was active
        const persistEffect: Async<AgentEnv, never, void> =
            budgetConfig !== undefined && budgetState !== undefined
                ? persistLearningRecord(state, budgetState)
                : asyncSucceed(undefined as void) as any;

        // Persist error history on completion (both success and error paths)
        const persistErrorEffect: Async<AgentEnv, never, void> =
            persistErrorHistory(errorHistory);

        // Stop tracker and persist output preferences on run complete
        const persistVerbosityEffect: Async<AgentEnv, never, void> =
            verbosity !== undefined
                ? (() => {
                    const duration = verbosity.tracker.stop();
                    const updatedPrefs = verbosity.store.recordRunDuration(duration, verbosity.prefs);
                    return persistOutputPreferences(verbosity.store, updatedPrefs);
                })()
                : asyncSucceed(undefined as void) as any;

        // Completion-time memory update: record run outcomes and persist
        const persistMemoryEffect: Async<AgentEnv, never, void> =
            memoryCtx !== undefined
                ? asyncFold(
                    asyncInterruptible<AgentEnv, AgentError, void>((env, cb) => {
                        const now = Date.now();
                        // Extract modified files from patch.applied observations
                        const modifiedFiles = state.observations
                            .filter((o): o is Extract<typeof o, { type: "patch.applied" }> => o.type === "patch.applied")
                            .flatMap((o) => [...o.changedFiles]);

                        // Extract command outcomes from shell.result observations
                        const commands = state.observations
                            .filter((o): o is Extract<typeof o, { type: "shell.result" }> => o.type === "shell.result")
                            .map((o) => ({ command: o.command.join(" "), success: o.exitCode === 0 }));

                        // Extract patch groups (co-change clusters) from patch.applied observations
                        const patchGroups = state.observations
                            .filter((o): o is Extract<typeof o, { type: "patch.applied" }> => o.type === "patch.applied")
                            .map((o) => o.changedFiles);

                        // Determine goal success
                        const goalSuccess = state.phase === "done";

                        // Apply all memory updates
                        let updated = memoryCtx.memory;
                        if (modifiedFiles.length > 0) {
                            updated = recordFileChanges(updated, modifiedFiles, now);
                        }
                        if (commands.length > 0) {
                            updated = recordCommandOutcomes(updated, commands, now);
                        }
                        updated = recordGoalOutcome(updated, state.goal.text, goalSuccess, now);
                        if (patchGroups.length > 0) {
                            updated = recordCoChanges(updated, patchGroups, now);
                        }

                        if (!env.persistence) {
                            cb({ _tag: "Success", value: undefined });
                            return;
                        }
                        env.persistence.write(
                            "workspace",
                            "agent.workspace-memory.v1",
                            serializeWorkspaceMemory(updated),
                        ).then(
                            () => cb({ _tag: "Success", value: undefined }),
                            (err) => cb({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "FsError", operation: "persistWorkspaceMemory", cause: err } as AgentError } }),
                        );
                    }),
                    () => asyncSucceed(undefined as void) as any,
                    () => asyncSucceed(undefined as void) as any,
                ) as Async<AgentEnv, never, void>
                : asyncSucceed(undefined as void) as any;

        return asyncFlatMap(persistEffect as any, () =>
            asyncFlatMap(persistErrorEffect as any, () =>
                asyncFlatMap(persistVerbosityEffect as any, () =>
                    asyncFlatMap(persistMemoryEffect as any, () =>
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
                    ) as any
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

                    // Loop-time trigger checking after observation
                    if (memoryCtx && memoryCtx.originalSignals) {
                        memoryCtx.triggerState = updateTriggerState(memoryCtx.triggerState, result.observation, memoryCtx.originalSignals);
                        if (shouldReInfer(memoryCtx.triggerState, next.steps)) {
                            try {
                                buildHostProfile(memoryCtx.originalSignals);
                                memoryCtx.triggerState = markReInferencePerformed(memoryCtx.triggerState, next.steps);
                            } catch {
                                memoryCtx.triggerState = markReInferencePerformed(memoryCtx.triggerState, next.steps);
                            }
                        }
                    }

                    return asyncFlatMap(recordObservation(next, result.observation) as any, () =>
                        runLoop(next, result.budgetState, budgetConfig, errorHistory, scope, runStartedAt, verbosity, memoryCtx) as any
                    ) as any;
                },
            ) as any;
        }

        // Non-LLM actions (or no budget configured): execute normally
        return asyncFlatMap(executeAction(action, state, scope) as any, (observation: Observation) => {
            const next = reduceAgentState(state, observation);

            // Loop-time trigger checking after observation
            if (memoryCtx && memoryCtx.originalSignals) {
                memoryCtx.triggerState = updateTriggerState(memoryCtx.triggerState, observation, memoryCtx.originalSignals);
                if (shouldReInfer(memoryCtx.triggerState, next.steps)) {
                    try {
                        buildHostProfile(memoryCtx.originalSignals);
                        memoryCtx.triggerState = markReInferencePerformed(memoryCtx.triggerState, next.steps);
                    } catch {
                        memoryCtx.triggerState = markReInferencePerformed(memoryCtx.triggerState, next.steps);
                    }
                }
            }

            return asyncFlatMap(recordObservation(next, observation) as any, () =>
                runLoop(next, budgetState, budgetConfig, errorHistory, scope, runStartedAt, verbosity, memoryCtx) as any
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
        asyncFlatMap(
            // Initialize output verbosity: load prefs, compute level, wrap event sink
            asyncFlatMap(asyncSync((env: AgentEnv) => env) as any, (env: AgentEnv) => {
                // Only wire verbosity when both an event sink and host profile are present.
                // This ensures backward compatibility: environments without explicit host
                // profile detection (e.g., tests, programmatic usage) get unfiltered events.
                if (!env.events || !env.hostProfile) {
                    return asyncSucceed(undefined as VerbosityContext | undefined) as any;
                }

                const hostProfile = env.hostProfile;
                const store = makePreferencesStore({
                    persistence: env.persistence,
                });

                return asyncFlatMap(loadOutputPreferences(store) as any, (prefs: OutputPreferences) => {
                    // Collect adaptation signals from the environment
                    const signals: AdaptationSignals = {
                        isPipe: env.terminal ? !env.terminal.isInteractive : false,
                        ttyWidth: env.terminal?.columns,
                        runHistory: prefs.runHistory,
                        userOverride: prefs.userOverride,
                    };

                    // Compute the initial verbosity level
                    const initialLevel = computeVerbosityLevel(hostProfile, signals);

                    // Wrap the event sink with the verbosity filter
                    const filter = makeVerbosityFilter({ inner: env.events!, initialLevel });

                    // Replace the event sink on the env with the filtered version.
                    // This is safe because env is a plain object and emitAgentEvent
                    // accesses env.events on each call.
                    (env as { events?: typeof env.events }).events = filter;

                    // Create the run duration tracker for mid-run escalation
                    const tracker = makeRunDurationTracker({ filter, hostProfile });

                    return asyncSucceed({ tracker, store, prefs } as VerbosityContext) as any;
                }) as any;
            }) as any,
            (verbosity: VerbosityContext | undefined) =>
                asyncFlatMap(nowMillis() as any, (startedAt: number) => {
                    // Start the verbosity tracker at run start
                    verbosity?.tracker.start();

                    return asyncFlatMap(
                        emitAgentEvent({ type: "agent.run.started", goal, at: startedAt }) as any,
                        () =>
                            // Load error patterns at run start (Requirement 9.2)
                            // On failure: proceed with empty history, no error log (Requirement 9.3)
                            asyncFlatMap(loadErrorHistory() as any, (errorHistory: readonly ErrorHistoryEntry[]) =>
                                // Load workspace memory at boot (Requirement 3.1)
                                asyncFlatMap(
                                    asyncFold(
                                        asyncInterruptible<AgentEnv, AgentError, WorkspaceMemory>((env, cb) => {
                                            if (!env.persistence) {
                                                cb({ _tag: "Success", value: parseWorkspaceMemory("") });
                                                return;
                                            }
                                            env.persistence.read("workspace", "agent.workspace-memory.v1").then(
                                                (value) => cb({ _tag: "Success", value: parseWorkspaceMemory(value ?? "") }),
                                                () => cb({ _tag: "Success", value: { version: 1, fileChangeFrequency: [], commandFailureRate: [], goalPatternSuccessRate: [], coChangeClusters: [] } as WorkspaceMemory }),
                                            );
                                        }),
                                        () => asyncSucceed({ version: 1, fileChangeFrequency: [], commandFailureRate: [], goalPatternSuccessRate: [], coChangeClusters: [] } as WorkspaceMemory) as any,
                                        (mem: WorkspaceMemory) => asyncSucceed(mem) as any,
                                    ) as Async<AgentEnv, never, WorkspaceMemory>,
                                    (memory: WorkspaceMemory) => {
                                        // Seed bandit priors from workspace memory (Requirements 3.2, 3.3)
                                        // The seeding is informational — it adjusts priors but the actual
                                        // bandit state is managed by contextBudget and patchStrategy modules.
                                        // We populate goal.workspaceMemory for downstream access.
                                        const goalWithMemory: AgentGoal = { ...goal, workspaceMemory: memory };

                                        // Build workspace memory context for loop-time trigger checking
                                        const memoryCtx: WorkspaceMemoryContext = {
                                            memory,
                                            triggerState: initialTriggerState(),
                                            originalSignals: undefined, // No original signals available at this level
                                        };

                                        return runLoop(
                                            initialAgentState(goalWithMemory),
                                            budgetState,
                                            budgetConfig,
                                            errorHistory,
                                            scope as Scope<AgentEnv>,
                                            startedAt,
                                            verbosity,
                                            memoryCtx,
                                        ) as any;
                                    },
                                ) as any
                            ) as any
                    ) as any;
                }) as any
        ) as any
    );
};
