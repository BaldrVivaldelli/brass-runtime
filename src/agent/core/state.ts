import type { AgentGoal, AgentState } from "./types";

export const initialAgentState = (goal: AgentGoal): AgentState => ({
    goal,
    phase: "boot",
    observations: [],
    errors: [],
    steps: 0,
});
