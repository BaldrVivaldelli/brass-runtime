import type { AgentEvent, AgentState } from "./types";

export const AGENT_PROTOCOL_NAME = "brass-agent" as const;
export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentProtocolEventMessage = {
    readonly protocol: typeof AGENT_PROTOCOL_NAME;
    readonly version: typeof AGENT_PROTOCOL_VERSION;
    readonly type: "event";
    readonly event: AgentEvent;
};

export type AgentProtocolFinalStateMessage = {
    readonly protocol: typeof AGENT_PROTOCOL_NAME;
    readonly version: typeof AGENT_PROTOCOL_VERSION;
    readonly type: "final-state";
    readonly state: AgentState;
};

export type AgentProtocolBatchSummaryMessage = {
    readonly protocol: typeof AGENT_PROTOCOL_NAME;
    readonly version: typeof AGENT_PROTOCOL_VERSION;
    readonly type: "batch-summary";
    readonly summary: {
        readonly total: number;
        readonly completed: number;
        readonly failed: number;
        readonly exitCode: number;
        readonly stoppedEarly: boolean;
    };
};

export type AgentProtocolErrorMessage = {
    readonly protocol: typeof AGENT_PROTOCOL_NAME;
    readonly version: typeof AGENT_PROTOCOL_VERSION;
    readonly type: "error";
    readonly message: string;
    readonly code?: string;
};

export type AgentProtocolMessage =
    | AgentProtocolEventMessage
    | AgentProtocolFinalStateMessage
    | AgentProtocolBatchSummaryMessage
    | AgentProtocolErrorMessage;
