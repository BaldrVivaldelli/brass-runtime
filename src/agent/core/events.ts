import { async, asyncFlatMap, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { AgentAction, AgentEnv, AgentError, AgentEvent, AgentPhase, AgentState, Observation } from "./types";

export const nowMillis = (): Async<unknown, never, number> =>
    async((_env, cb) => {
        cb({ _tag: "Success", value: Date.now() });
    });

export const emitAgentEvent = (event: AgentEvent): Async<AgentEnv, never, void> =>
    async((env, cb) => {
        try {
            env.events?.emit(event);
        } catch {
            // Observability must never change agent semantics.
            // Sinks are intentionally best-effort.
        }

        cb({ _tag: "Success", value: undefined });
    });

export const emitAgentEvents = (events: readonly AgentEvent[]): Async<AgentEnv, never, void> =>
    events.reduce(
        (acc, event) => asyncFlatMap(acc, () => emitAgentEvent(event) as any) as any,
        asyncSucceed(undefined) as Async<AgentEnv, never, void>
    );

export const summarizeAgentAction = (action: AgentAction): string => {
    switch (action.type) {
        case "fs.readFile":
            return `read ${action.path}`;
        case "fs.exists":
            return `check ${action.path}`;
        case "fs.searchText":
            return `search \"${action.query}\"`;
        case "shell.exec":
            return action.command.join(" ");
        case "llm.complete":
            return `llm.${action.purpose}`;
        case "patch.propose":
            return "propose patch";
        case "patch.apply":
            return "apply patch";
        case "patch.rollback":
            return "rollback patch";
        case "agent.finish":
            return "finish";
        case "agent.fail":
            return "fail";
    }
};

export const summarizeAgentObservation = (observation: Observation): string => {
    switch (observation.type) {
        case "fs.fileRead":
            return `read ${observation.path}`;
        case "fs.exists":
            return `${observation.exists ? "found" : "missing"} ${observation.path}`;
        case "fs.searchResult":
            return `search \"${observation.query}\" (${observation.matches.length} matches)`;
        case "shell.result":
            return `${observation.command.join(" ")} exited ${observation.exitCode}`;
        case "llm.response":
            return `llm.${observation.purpose} responded`;
        case "patch.proposed":
            return "patch proposed";
        case "patch.applied":
            return `patch applied (${observation.changedFiles.join(", ") || "no files reported"})`;
        case "patch.rolledBack":
            return `patch rolled back (${observation.changedFiles.join(", ") || "no files reported"})`;
        case "agent.done":
            return "done";
        case "agent.error":
            return `error ${observation.error._tag}`;
    }
};

export const observationStatus = (observation: Observation): "ok" | "warn" | "fail" => {
    switch (observation.type) {
        case "agent.error":
            return "fail";
        case "shell.result":
            return observation.exitCode === 0 ? "ok" : "warn";
        default:
            return "ok";
    }
};

export const errorEventFor = (
    action: AgentAction,
    state: AgentState,
    error: AgentError,
    at: number
): AgentEvent | undefined => {
    switch (error._tag) {
        case "ToolTimeout":
            return {
                type: "agent.tool.timeout",
                action,
                step: state.steps + 1,
                phase: state.phase,
                timeoutMs: error.timeoutMs,
                at,
            };
        case "PermissionDenied":
            return {
                type: "agent.permission.denied",
                action,
                step: state.steps + 1,
                phase: state.phase,
                reason: error.reason,
                at,
            };
        default:
            return undefined;
    }
};

export const observationEventFor = (
    state: AgentState,
    observation: Observation,
    at: number
): AgentEvent | undefined => {
    switch (observation.type) {
        case "patch.applied":
            return {
                type: "agent.patch.applied",
                step: state.steps,
                phase: state.phase,
                changedFiles: observation.changedFiles,
                automaticRollbackEligible: Boolean(observation.patch),
                at,
            };
        case "patch.rolledBack":
            return {
                type: "agent.patch.rolledBack",
                step: state.steps,
                phase: state.phase,
                changedFiles: observation.changedFiles,
                ...(observation.automatic !== undefined ? { automatic: observation.automatic } : {}),
                ...(observation.reason ? { reason: observation.reason } : {}),
                at,
            };
        default:
            return undefined;
    }
};

export const runStatusFor = (phase: AgentPhase): "done" | "failed" => (phase === "done" ? "done" : "failed");
