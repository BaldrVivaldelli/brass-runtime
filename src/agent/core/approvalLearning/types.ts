// src/agent/core/approvalLearning/types.ts

import type { AgentActionType } from "../types";

/** A single recorded approval decision. */
export type ApprovalObservation = {
  readonly approved: boolean;
  readonly timestamp: number;
};

/** Per-action-type observation history. */
export type ActionTypeHistory = {
  readonly actionType: AgentActionType;
  readonly observations: readonly ApprovalObservation[];
};

/** Complete persisted approval history. */
export type ApprovalHistory = {
  readonly version: 1;
  readonly actions: Readonly<Record<string, ActionTypeHistory>>;
};

/** Configuration for the learning layer. */
export type LearningConfig = {
  readonly confidenceThreshold: number;   // (0, 1], default 0.95
  readonly observationWindow: number;     // positive integer, default 50
  readonly decayFactor: number;           // (0, 1), default 0.85
  readonly minSampleSize: number;         // positive integer, default 5
};

/** Factory for empty approval history. */
export const emptyApprovalHistory = (): ApprovalHistory => ({
  version: 1,
  actions: {},
});

/** Default configuration values. */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  confidenceThreshold: 0.95,
  observationWindow: 50,
  decayFactor: 0.85,
  minSampleSize: 5,
};
