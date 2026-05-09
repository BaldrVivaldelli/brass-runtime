// src/http/adaptiveLimiter/index.ts

export { AdaptiveLimiter } from "./adaptiveLimiter";
export { LatencyWindow } from "./latencyWindow";
export { EmaComputer } from "./ema";
export { computeGradient, computeNewLimit } from "./gradient";
export {
  type AdaptiveLimiterConfig,
  type AdaptiveLimiterPreset,
  type LimitChangeEvent,
  type AdaptiveLimiterStats,
  type AdaptiveLimiterKeySnapshot,
  type AdaptiveLimiterDiagnostics,
  type AdaptiveLease,
  type AdaptiveHeadroomContext,
  type AdaptiveHeadroomMode,
  type AdaptiveHeadroomStrategy,
  type AdaptiveBaselineStrategy,
  type AdaptiveQueueStrategy,
  type AdaptiveQueueLoadShedding,
  type AdaptiveAcquireOptions,
  type AdaptiveReleaseInfo,
  type ResolvedConfig,
  adaptiveLimiterPresets,
  makeAdaptiveLimiterConfig,
  validateConfig,
  resolveConfig,
} from "./types";
