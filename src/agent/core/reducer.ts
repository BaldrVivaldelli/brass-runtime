import type { AgentPhase, AgentState, Observation } from "./types";

const MAX_AGENT_STEPS = 60;

const phaseAfter = (current: AgentPhase, observation: Observation): AgentPhase => {
    switch (observation.type) {
        case "agent.done":
            return "done";
        case "agent.error":
            return current;
        case "fs.fileRead":
        case "fs.exists":
        case "fs.searchResult":
            return "discovering";
        case "shell.result":
            return "validating";
        case "llm.response":
            return "planning";
        case "patch.proposed":
            return "proposing";
        case "patch.applied":
        case "patch.rolledBack":
            return "validating";
    }
};

export const reduceAgentState = (state: AgentState, observation: Observation): AgentState => {
    const steps = state.steps + 1;
    const phase = steps >= MAX_AGENT_STEPS ? "failed" : phaseAfter(state.phase, observation);

    return {
        ...state,
        phase,
        observations: [...state.observations, observation],
        errors: observation.type === "agent.error" ? [...state.errors, observation.error] : state.errors,
        steps,
    };
};

export const isTerminal = (state: AgentState): boolean =>
    state.phase === "done" || state.phase === "failed" || state.steps >= MAX_AGENT_STEPS;
