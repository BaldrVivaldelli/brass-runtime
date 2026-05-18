// src/agent/core/llmBudget/events.ts — Budget event constructors

import type { LLMPurpose } from "../types";
import type {
    BudgetEvent,
    ComplexitySignals,
    ConfidenceSignals,
    ModelTier,
    TokenUsage,
} from "./types";

export const makeBudgetUsageEvent = (
    usage: TokenUsage,
    cumulative: { readonly totalTokens: number; readonly callCount: number },
    tier: ModelTier,
    remaining: number,
): BudgetEvent => ({
    type: "budget.usage",
    usage,
    cumulative,
    tier,
    remaining,
    at: Date.now(),
});

export const makeBudgetRoutedEvent = (
    tier: ModelTier,
    signals: ComplexitySignals,
    resolvedProvider: string | undefined,
): BudgetEvent => ({
    type: "budget.routed",
    tier,
    signals,
    resolvedProvider,
    at: Date.now(),
});

export const makeBudgetConfidenceEvent = (
    score: number,
    signals: ConfidenceSignals,
    purpose: LLMPurpose,
): BudgetEvent => ({
    type: "budget.confidence",
    score,
    signals,
    purpose,
    at: Date.now(),
});

export const makeBudgetWarningEvent = (
    totalTokens: number,
    tokenBudget: number,
): BudgetEvent => ({
    type: "budget.warning",
    totalTokens,
    tokenBudget,
    at: Date.now(),
});

export const makeBudgetExceededEvent = (
    totalTokens: number,
    tokenBudget: number,
    overshootFraction: number,
    hardCap: number,
): BudgetEvent => ({
    type: "budget.exceeded",
    totalTokens,
    tokenBudget,
    overshootFraction,
    hardCap,
    at: Date.now(),
});
