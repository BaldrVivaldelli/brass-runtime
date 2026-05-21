// src/agent/core/approvalLearning/index.ts

export * from "./types";
export { computeConfidence, shouldAutoApprove, decayWeight } from "./confidence";
export {
  type HistoryStore,
  APPROVAL_HISTORY_PATH,
  parseApprovalHistory,
  serializeApprovalHistory,
  makeFileHistoryStore,
  makeInMemoryHistoryStore,
  addObservation,
} from "./store";
export { makeLearningApprovalService, validateConfig } from "./learningService";
export type { LearningApprovalServiceConfig } from "./learningService";
