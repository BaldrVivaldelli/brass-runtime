// src/http/prewarm/index.ts — Barrel export for the HTTP Connection Pre-warming module.

// New prewarm types
export type {
  PrewarmConfig,
  PrewarmResult,
  PrewarmResultStatus,
  PrewarmEvent,
  PrewarmEventType,
  PrewarmOriginState,
  PrewarmOriginStatus,
  PrewarmStatusSnapshot,
} from "./types";

// PrewarmManager
export { makePrewarmManager } from "./prewarmManager";
export type { PrewarmManager } from "./prewarmManager";

// Building blocks
export { validateOrigin } from "./validation";
export { detectPlatform, validateFetchAvailable } from "./platform";
export { executeProbe } from "./probe";
export type { ProbeOutcome } from "./probe";
export { makeConnectionStateMap } from "./connectionState";
export type { ConnectionStateMap } from "./connectionState";
export { makeBudgetSemaphore } from "./budgetSemaphore";
export type { BudgetSemaphore } from "./budgetSemaphore";

// Legacy prewarm exports (preserved for backward compatibility)
export {
  prewarmConnections,
  prewarmHttpConnections,
  withConnectionPrewarming,
} from "./legacy";
export type {
  ConnectionPrewarmAttempt,
  ConnectionPrewarmResult,
  ConnectionPrewarmEvent,
  ConnectionPrewarmConfig,
  ConnectionPrewarmingMiddlewareConfig,
} from "./legacy";
