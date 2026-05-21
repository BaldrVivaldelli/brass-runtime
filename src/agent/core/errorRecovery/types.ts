// src/agent/core/errorRecovery/types.ts

import type { AgentError } from "../types";

export type ErrorCategory = "PatchError" | "LLMError" | "ShellError" | "FsError" | "unknown";

export type PatchErrorSubcategory = "parse" | "apply" | "conflict";

export type LLMErrorSubcategory = "timeout" | "rate-limit";

export type CategorizedError =
    | { readonly category: "PatchError"; readonly subcategory: PatchErrorSubcategory; readonly raw: AgentError }
    | { readonly category: "LLMError"; readonly subcategory: LLMErrorSubcategory; readonly raw: AgentError }
    | { readonly category: "ShellError"; readonly subcategory: undefined; readonly raw: AgentError }
    | { readonly category: "FsError"; readonly subcategory: undefined; readonly raw: AgentError }
    | { readonly category: "unknown"; readonly subcategory: undefined; readonly raw: AgentError };

export type RecoveryAction =
    | { readonly type: "retry"; readonly prompt: string; readonly errorContext: string }
    | { readonly type: "wait"; readonly durationMs: number; readonly reason: string }
    | { readonly type: "skip"; readonly reason: string }
    | { readonly type: "escalate"; readonly targetMode: "propose"; readonly reason: string }
    | { readonly type: "terminate"; readonly summary: string };

export type ErrorHistoryEntry = {
    readonly category: ErrorCategory;
    readonly subcategory: PatchErrorSubcategory | LLMErrorSubcategory | undefined;
    readonly timestamp: number;
    readonly resolved: boolean;
};

export type ErrorHistory = {
    readonly entries: readonly ErrorHistoryEntry[];
};

export type StoredErrorPatterns = {
    readonly version: 1;
    readonly entries: readonly ErrorHistoryEntry[];
};

export type RecoveryState = {
    readonly consecutiveCount: number;
    readonly category: ErrorCategory;
    readonly subcategory: PatchErrorSubcategory | LLMErrorSubcategory | undefined;
    readonly repairBudgetRemaining: number;
};
