import type { AgentLLMConfig } from "../config";
import type { LLMPurpose } from "../types";

export type ModelTier = "small" | "large";

export type ModelTiersConfig = Readonly<Record<ModelTier, AgentLLMConfig>>;

export type BudgetConfigInput = {
    readonly tokenBudget?: number;
    readonly overshootFraction?: number;
    readonly enabled?: boolean;
    readonly modelTiers?: ModelTiersConfig;
};

export type BudgetConfig = {
    readonly tokenBudget: number;
    readonly overshootFraction: number;
    readonly enabled: boolean;
    readonly modelTiers?: ModelTiersConfig;
};

export type TokenUsage = {
    readonly inputTokens: number;
    readonly outputTokens: number;
};

export type BudgetCallRecord = {
    readonly usage: TokenUsage;
    readonly tier: ModelTier;
    readonly confidence: number;
    readonly estimated: boolean;
};

export type BudgetState = {
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalTokens: number;
    readonly callCount: number;
    readonly calls: readonly BudgetCallRecord[];
};

export type BudgetStatus =
    | { readonly type: "under" }
    | { readonly type: "warning"; readonly overage: number }
    | { readonly type: "exceeded"; readonly overage: number };

export type ConfidenceSignals = {
    readonly hasDiffBlock: boolean;
    readonly isConcise: boolean;
    readonly referencesGoal: boolean;
    readonly referencesReadFiles: boolean;
    readonly hedgingCount: number;
};

export type ComplexitySignals = {
    readonly goalLength: number;
    readonly filesRead: number;
    readonly searchMatches: number;
    readonly hasValidationErrors: boolean;
    readonly repairAttempts: number;
};

export type BudgetEvent =
    | {
        readonly type: "budget.usage";
        readonly usage: TokenUsage;
        readonly cumulative: { readonly totalTokens: number; readonly callCount: number };
        readonly tier: ModelTier;
        readonly remaining: number;
        readonly at: number;
    }
    | {
        readonly type: "budget.routed";
        readonly tier: ModelTier;
        readonly signals: ComplexitySignals;
        readonly resolvedProvider: string | undefined;
        readonly at: number;
    }
    | {
        readonly type: "budget.confidence";
        readonly score: number;
        readonly signals: ConfidenceSignals;
        readonly purpose: LLMPurpose;
        readonly at: number;
    }
    | {
        readonly type: "budget.warning";
        readonly totalTokens: number;
        readonly tokenBudget: number;
        readonly at: number;
    }
    | {
        readonly type: "budget.exceeded";
        readonly totalTokens: number;
        readonly tokenBudget: number;
        readonly overshootFraction: number;
        readonly hardCap: number;
        readonly at: number;
    };
