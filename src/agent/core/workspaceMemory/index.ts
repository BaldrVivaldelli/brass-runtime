// src/agent/core/workspaceMemory/index.ts

export * from "./types";
export {
  evictToCapacity,
  recordFileChanges,
  recordCommandOutcomes,
  recordGoalOutcome,
  recordCoChanges,
} from "./memory";
export {
  computeAdjustedPriors,
  seedContextBanditPriors,
  seedPatchStrategyPriors,
} from "./seeding";
export {
  type TriggerState,
  initialTriggerState,
  RE_INFERENCE_COOLDOWN_STEPS,
  detectTrigger,
  updateTriggerState,
  shouldReInfer,
  markReInferencePerformed,
} from "./triggers";
export {
  WORKSPACE_MEMORY_PATH,
  serializeWorkspaceMemory,
  parseWorkspaceMemory,
  loadWorkspaceMemory,
  persistWorkspaceMemory,
} from "./store";
