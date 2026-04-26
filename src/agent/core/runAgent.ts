import { asyncFold, asyncFlatMap, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { Runtime } from "../../core/runtime/runtime";
import type { Scope } from "../../core/runtime/scope";
import { withScopeAsync } from "../../core/runtime/scope";
import type { AgentAction, AgentEnv, AgentError, AgentGoal, AgentState, Observation } from "./types";
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

const runLoop = (
    state: AgentState,
    scope: Scope<AgentEnv>,
    runStartedAt: number
): Async<AgentEnv, AgentError, AgentState> => {
    if (isTerminal(state)) {
        return asyncFlatMap(nowMillis() as any, (at: number) =>
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
        ) as any;
    }

    return asyncFlatMap(decideNextAction(state) as any, (action: AgentAction) =>
        asyncFlatMap(executeAction(action, state, scope) as any, (observation: Observation) => {
            const next = reduceAgentState(state, observation);

            return asyncFlatMap(recordObservation(next, observation) as any, () =>
                runLoop(next, scope, runStartedAt) as any
            ) as any;
        }) as any
    ) as any;
};

export const runAgent = (runtime: Runtime<AgentEnv>, goal: AgentGoal): Async<AgentEnv, AgentError, AgentState> =>
    withScopeAsync(runtime, (scope) =>
        asyncFlatMap(nowMillis() as any, (startedAt: number) =>
            asyncFlatMap(
                emitAgentEvent({ type: "agent.run.started", goal, at: startedAt }) as any,
                () => runLoop(initialAgentState(goal), scope as Scope<AgentEnv>, startedAt) as any
            ) as any
        ) as any
    );
