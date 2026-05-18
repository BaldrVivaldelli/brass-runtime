// src/agent/core/llmBudget/index.ts — barrel re-export

export type {
    ModelTier,
    ModelTiersConfig,
    BudgetConfigInput,
    BudgetConfig,
    TokenUsage,
    BudgetCallRecord,
    BudgetState,
    BudgetStatus,
} from "./types";

// Uncomment as modules are implemented:
export { resolveBudgetConfig, validateBudgetConfig } from "./config";
export { initBudgetState, updateBudgetState, budgetStatus, budgetAllowsCall } from "./state";
export { estimateTokens } from "./estimation";
export { estimateConfidence, extractConfidenceSignals } from "./confidence";
export type { ConfidenceSignals } from "./types";
export { routeModel, extractComplexitySignals } from "./router";
export type { ComplexityThresholds } from "./router";
export type { BudgetEvent } from "./types";
export {
    makeBudgetUsageEvent,
    makeBudgetRoutedEvent,
    makeBudgetConfidenceEvent,
    makeBudgetWarningEvent,
    makeBudgetExceededEvent,
} from "./events";
export { parseLearningStore, appendRunRecord, serializeLearningStore } from "./persistence";
export type { LearningRunRecord, LearningStore } from "./persistence";
