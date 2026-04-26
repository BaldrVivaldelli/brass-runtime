import type {
    AgentContextConfig,
    AgentLanguageConfig,
    AgentPatchQualityConfig,
    AgentRedactionConfig,
    AgentRollbackConfig,
    AgentMode,
    AgentProjectConfig,
    AgentToolPolicyConfig,
    ApprovalDefaultAnswer,
    ApprovalRisk,
} from "./types";
import type { AgentBatchConfig } from "./batch";

export type AgentConfigApprovalMode = "auto" | "interactive" | "approve" | "deny";

export type AgentConfigLLMProvider = "fake" | "google" | "gemini" | "openai" | "openai-compatible";

export type AgentLLMConfig = {
    readonly provider?: AgentConfigLLMProvider;
    readonly model?: string;
    readonly endpoint?: string;
    readonly baseUrl?: string;
    readonly apiVersion?: string;
    readonly apiKeyEnv?: string;
    readonly systemInstruction?: string;
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly maxOutputTokens?: number;
    readonly fakeResponse?: string;
};

export type ShellAskRule =
    | string
    | {
        readonly pattern: string;
        readonly reason?: string;
        readonly risk?: ApprovalRisk;
        readonly defaultAnswer?: ApprovalDefaultAnswer;
    };

export type ShellPermissionConfig = {
    /**
     * When true or omitted, the built-in safe read/validation commands remain
     * allowed. Set to false for a strict allowlist defined only by this file.
     */
    readonly inheritDefaults?: boolean;
    readonly allow?: readonly string[];
    readonly ask?: readonly ShellAskRule[];
    readonly deny?: readonly string[];
};

export type PatchApplyPermissionConfig =
    | "allow"
    | "ask"
    | "deny"
    | {
        readonly decision?: "allow" | "ask" | "deny";
        readonly reason?: string;
        readonly risk?: ApprovalRisk;
        readonly defaultAnswer?: ApprovalDefaultAnswer;
    };

export type AgentPermissionConfig = {
    readonly shell?: ShellPermissionConfig;
    readonly patchApply?: PatchApplyPermissionConfig;
};

export type AgentConfig = {
    readonly mode?: AgentMode;
    readonly approval?: AgentConfigApprovalMode;
    readonly llm?: AgentLLMConfig;
    readonly project?: AgentProjectConfig;
    readonly context?: AgentContextConfig;
    readonly patchQuality?: AgentPatchQualityConfig;
    readonly rollback?: AgentRollbackConfig;
    readonly redaction?: AgentRedactionConfig;
    readonly language?: AgentLanguageConfig;
    readonly permissions?: AgentPermissionConfig;
    readonly tools?: AgentToolPolicyConfig;
    readonly batch?: AgentBatchConfig;
};

export type LoadedAgentConfig = {
    readonly path?: string;
    readonly config: AgentConfig;
};

export const isAgentConfigMode = (value: string): value is AgentMode =>
    value === "read-only" || value === "propose" || value === "write" || value === "autonomous";

export const isAgentConfigApprovalMode = (value: string): value is AgentConfigApprovalMode =>
    value === "auto" || value === "interactive" || value === "approve" || value === "deny";

export const isAgentConfigLLMProvider = (value: string): value is AgentConfigLLMProvider =>
    value === "fake" || value === "google" || value === "gemini" || value === "openai" || value === "openai-compatible";

export const AGENT_CONFIG_FILE_NAMES = [".brass-agent.json", "brass-agent.config.json"] as const;
