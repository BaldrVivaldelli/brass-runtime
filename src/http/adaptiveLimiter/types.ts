// src/http/adaptiveLimiter/types.ts

import type { HttpPoolKeyResolver } from "../pool";

export type AdaptiveHeadroomMode =
  | "stable"
  | "probe"
  | "warmup"
  | "slow-start"
  | "circuit-open";

export type AdaptiveHeadroomContext = {
  readonly key: string;
  readonly currentLimit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly gradient: number;
  readonly mode: AdaptiveHeadroomMode;
};

export type AdaptiveHeadroomStrategy =
  | number
  | "fixed"
  | "proportional"
  | {
      readonly type: "fixed";
      readonly value?: number;
    }
  | {
      readonly type: "proportional";
      readonly ratio?: number;
      readonly min?: number;
      readonly max?: number;
    }
  | ((context: AdaptiveHeadroomContext) => number);

export type AdaptiveBaselineStrategy = "min" | "p5" | "ema-low";
export type AdaptiveQueueStrategy = "fifo" | "priority";
export type AdaptiveQueueLoadShedding = "reject-new" | "priority-evict";
export type AdaptiveLimiterPreset = "conservative" | "balanced" | "aggressive";

export type AdaptiveAcquireOptions = {
  /** Request priority from 0 (highest) to 9 (lowest). Default: 5. */
  readonly priority?: number;
};

export type AdaptiveReleaseInfo = {
  /** HTTP response status, used by the error signal when >= 500 by default. */
  readonly status?: number;
  /** Marks a failed request without an HTTP response, e.g. fetch error or timeout. */
  readonly error?: boolean;
};

/**
 * Configuration for the adaptive concurrency limiter.
 * All fields are optional with sensible defaults.
 */
export type AdaptiveLimiterConfig = {
  /** Named production preset used before caller overrides are applied. */
  readonly preset?: AdaptiveLimiterPreset;
  /** Initial concurrency limit. Default: 10. */
  readonly initialLimit?: number;
  /** Minimum concurrency limit. Default: 1. */
  readonly minLimit?: number;
  /** Maximum concurrency limit. Default: 200. */
  readonly maxLimit?: number;
  /** EMA smoothing factor in (0, 1]. Default: 0.5. */
  readonly smoothingFactor?: number;
  /** Number of completions between probes. Default: 10. */
  readonly probeInterval?: number;
  /** Random probe interval spread. 0 disables jitter, 0.2 means ±20%. Default: 0.2. */
  readonly probeJitterRatio?: number;
  /** Sliding window size for latency samples. Default: 100. */
  readonly windowSize?: number;
  /** Minimum samples before the limiter may change its limit. Default: 10. */
  readonly minSamples?: number;
  /** Baseline used for gradient computation. Default: "min". */
  readonly baselineStrategy?: AdaptiveBaselineStrategy;
  /** Samples to wait after a decrease before allowing another decrease. Default: 0. */
  readonly decreaseCooldownSamples?: number;
  /** Number of limit-change events retained per key for diagnostics. Default: 32. */
  readonly historySize?: number;
  /** Exponential decay applied to percentile windows. 1 disables weighting. Default: 1. */
  readonly windowDecayFactor?: number;
  /** Error signal weight blended with latency gradient. 0 disables. Default: 0. */
  readonly errorWeight?: number;
  /** EMA smoothing factor for the error rate signal. Defaults to smoothingFactor. */
  readonly errorSmoothingFactor?: number;
  /** HTTP status at/above which responses count as downstream errors. Default: 500. */
  readonly errorStatusThreshold?: number;
  /** Internal queue ordering. Default: "fifo". */
  readonly queueStrategy?: AdaptiveQueueStrategy;
  /** Queue-full behavior. Default: "reject-new". */
  readonly queueLoadShedding?: AdaptiveQueueLoadShedding;
  /** Rejection streak before PoolRejected carries retryAfterMs. Default: 3. */
  readonly rejectionBackoffThreshold?: number;
  /** Backoff hint for sustained PoolRejected errors. Default: undefined. */
  readonly rejectionBackoffMs?: number;
  /** Remove inactive per-key state after this idle period. Use false to disable. Default: 300000. */
  readonly stateTtlMs?: number | false;
  /** Number of valid completions used for explicit linear warmup. 0 disables. Default: 0. */
  readonly warmupRequests?: number;
  /** Gradient below which the limiter decreases concurrency. Default: 0.75. */
  readonly decreaseThreshold?: number;
  /** Gradient at or above which the limiter may increase concurrency. Default: 1.0. */
  readonly increaseThreshold?: number;
  /** Maximum fraction of the current limit that can be removed in one adjustment. Default: 0.2. */
  readonly maxDecreaseRatio?: number;
  /** Fixed, proportional, or custom headroom added on stable growth/probes. Default: 1. */
  readonly headroomStrategy?: AdaptiveHeadroomStrategy;
  /** Enable fast recovery after sustained saturation. Default: true. */
  readonly slowStartRecovery?: boolean;
  /** Gradient at/below which samples count as strong saturation. Default: 0.5. */
  readonly slowStartSaturationThreshold?: number;
  /** Consecutive strong-saturation samples before slow-start recovery arms. Default: 3. */
  readonly slowStartSaturationSamples?: number;
  /** Key resolver for isolation scope. Default: "origin". */
  readonly key?: HttpPoolKeyResolver;
  /** Maximum queue depth per key. Default: 256. */
  readonly maxQueue?: number;
  /** Queue timeout in ms. Default: undefined (no timeout). */
  readonly queueTimeoutMs?: number;
  /** Callback invoked when the limit changes. */
  readonly onLimitChange?: (event: LimitChangeEvent) => void;
  /** Which percentile to use for gradient computation. Default: "p50". */
  readonly percentile?: "p50" | "p99";
};

/**
 * Event emitted when the concurrency limit changes.
 */
export type LimitChangeEvent = {
  readonly key: string;
  readonly previousLimit: number;
  readonly newLimit: number;
  readonly gradient: number;
  readonly latencyGradient: number;
  readonly errorRate: number;
  readonly smoothedLatency: number;
  readonly minLatency: number;
  readonly baselineLatency: number;
  readonly p5: number | undefined;
  readonly timestamp: number;
  readonly reason?: "gradient" | "probe" | "warmup" | "slow-start" | "circuit-open";
};

/**
 * Snapshot of the adaptive limiter's current state for a given key.
 */
export type AdaptiveLimiterStats = {
  readonly limit: number;
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly gradient: number | undefined;
  readonly latencyGradient: number | undefined;
  readonly errorRate: number | undefined;
  readonly smoothedLatency: number | undefined;
  readonly minLatency: number | undefined;
  readonly baselineLatency: number | undefined;
  readonly p5: number | undefined;
  readonly p50: number | undefined;
  readonly p99: number | undefined;
  readonly probeCount: number;
  readonly windowSize: number;
  readonly warmupCompletions?: number;
  readonly slowStart?: boolean;
  readonly cooldownSamplesRemaining?: number;
  readonly utilization?: number;
  readonly requestsPerSecond?: number;
  readonly completionsPerSecond?: number;
  readonly rejectionRate?: number;
  readonly suggestedBackoffMs?: number;
  readonly stateCount?: number;
  readonly keys?: readonly string[];
};

export type AdaptiveLimiterKeySnapshot = AdaptiveLimiterStats & {
  readonly key: string;
  readonly createdAt: number;
  readonly createdTimestamp: number;
  readonly lastActivityAt: number;
  readonly lastActivityTimestamp: number;
  readonly nextProbeAt: number;
  readonly warmupDone: boolean;
  readonly saturationStreak: number;
  readonly slowStartRecoveryStarted: boolean;
  readonly history: readonly LimitChangeEvent[];
  readonly acquired: number;
  readonly released: number;
  readonly rejected: number;
  readonly queueTimeouts: number;
  readonly abortedWhileQueued: number;
  readonly evictedWhileQueued: number;
};

export type AdaptiveLimiterDiagnostics = {
  readonly stateCount: number;
  readonly keys: readonly string[];
  readonly aggregate: AdaptiveLimiterStats;
  readonly states: readonly AdaptiveLimiterKeySnapshot[];
  readonly history: readonly LimitChangeEvent[];
};

/**
 * A lease representing an acquired concurrency slot.
 * Call `release(latencyMs)` when the request completes to record latency and free the slot.
 */
export type AdaptiveLease = {
  readonly key: string;
  release(latencyMs: number, info?: AdaptiveReleaseInfo): void;
};

/** Resolved (non-optional) configuration with defaults applied. */
export type ResolvedConfig = {
  readonly preset: AdaptiveLimiterPreset | undefined;
  readonly initialLimit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly smoothingFactor: number;
  readonly probeInterval: number;
  readonly probeJitterRatio: number;
  readonly windowSize: number;
  readonly minSamples: number;
  readonly baselineStrategy: AdaptiveBaselineStrategy;
  readonly decreaseCooldownSamples: number;
  readonly historySize: number;
  readonly windowDecayFactor: number;
  readonly errorWeight: number;
  readonly errorSmoothingFactor: number;
  readonly errorStatusThreshold: number;
  readonly queueStrategy: AdaptiveQueueStrategy;
  readonly queueLoadShedding: AdaptiveQueueLoadShedding;
  readonly rejectionBackoffThreshold: number;
  readonly rejectionBackoffMs: number | undefined;
  readonly stateTtlMs: number | undefined;
  readonly warmupRequests: number;
  readonly decreaseThreshold: number;
  readonly increaseThreshold: number;
  readonly maxDecreaseRatio: number;
  readonly headroomStrategy: AdaptiveHeadroomStrategy;
  readonly slowStartRecovery: boolean;
  readonly slowStartSaturationThreshold: number;
  readonly slowStartSaturationSamples: number;
  readonly key: HttpPoolKeyResolver;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number | undefined;
  readonly onLimitChange: ((event: LimitChangeEvent) => void) | undefined;
  readonly percentile: "p50" | "p99";
};

export const adaptiveLimiterPresets = Object.freeze({
  conservative: Object.freeze({
    initialLimit: 8,
    minLimit: 2,
    maxLimit: 64,
    maxQueue: 256,
    queueTimeoutMs: 30_000,
    smoothingFactor: 0.3,
    probeInterval: 40,
    probeJitterRatio: 0.2,
    windowSize: 100,
    minSamples: 80,
    baselineStrategy: "p5",
    windowDecayFactor: 0.99,
    errorWeight: 0.2,
    decreaseThreshold: 0.65,
    maxDecreaseRatio: 0.08,
    headroomStrategy: "fixed",
    queueStrategy: "priority",
    queueLoadShedding: "priority-evict",
    rejectionBackoffThreshold: 2,
    rejectionBackoffMs: 150,
    percentile: "p50",
  }),
  balanced: Object.freeze({
    initialLimit: 16,
    minLimit: 4,
    maxLimit: 128,
    maxQueue: 512,
    queueTimeoutMs: 30_000,
    smoothingFactor: 0.35,
    probeInterval: 25,
    probeJitterRatio: 0.2,
    windowSize: 100,
    minSamples: 50,
    baselineStrategy: "p5",
    windowDecayFactor: 0.98,
    errorWeight: 0.25,
    decreaseThreshold: 0.5,
    maxDecreaseRatio: 0.1,
    headroomStrategy: { type: "proportional" as const, ratio: 0.05 },
    queueStrategy: "priority",
    queueLoadShedding: "priority-evict",
    rejectionBackoffThreshold: 3,
    rejectionBackoffMs: 100,
    percentile: "p50",
  }),
  aggressive: Object.freeze({
    initialLimit: 32,
    minLimit: 8,
    maxLimit: 256,
    maxQueue: 1_024,
    queueTimeoutMs: 30_000,
    smoothingFactor: 0.35,
    probeInterval: 20,
    probeJitterRatio: 0.2,
    windowSize: 160,
    minSamples: 100,
    baselineStrategy: "p5",
    windowDecayFactor: 0.98,
    errorWeight: 0.25,
    decreaseThreshold: 0.5,
    maxDecreaseRatio: 0.1,
    headroomStrategy: { type: "proportional" as const, ratio: 0.05 },
    queueStrategy: "priority",
    queueLoadShedding: "priority-evict",
    rejectionBackoffThreshold: 3,
    rejectionBackoffMs: 100,
    percentile: "p50",
  }),
} satisfies Record<AdaptiveLimiterPreset, Readonly<Partial<AdaptiveLimiterConfig>>>);

export function makeAdaptiveLimiterConfig(
  preset: AdaptiveLimiterPreset,
  overrides: AdaptiveLimiterConfig = {},
): AdaptiveLimiterConfig {
  return {
    ...adaptiveLimiterPresets[preset],
    ...overrides,
    preset,
  };
}

/**
 * Validates the adaptive limiter configuration.
 * Throws a descriptive error for invalid combinations.
 */
export function validateConfig(config: AdaptiveLimiterConfig): void {
  if (
    config.preset !== undefined &&
    config.preset !== "conservative" &&
    config.preset !== "balanced" &&
    config.preset !== "aggressive"
  ) {
    throw new Error(
      `AdaptiveLimiter: preset must be "conservative", "balanced", or "aggressive", got ${config.preset}`,
    );
  }
  if (config.smoothingFactor !== undefined) {
    if (config.smoothingFactor <= 0 || config.smoothingFactor > 1) {
      throw new Error(
        `AdaptiveLimiter: smoothingFactor must be in (0, 1], got ${config.smoothingFactor}`,
      );
    }
  }
  if (config.windowSize !== undefined) {
    if (config.windowSize < 2) {
      throw new Error(
        `AdaptiveLimiter: windowSize must be >= 2, got ${config.windowSize}`,
      );
    }
  }
  if (config.probeInterval !== undefined) {
    if (config.probeInterval < 1) {
      throw new Error(
        `AdaptiveLimiter: probeInterval must be >= 1, got ${config.probeInterval}`,
      );
    }
  }
  if (config.probeJitterRatio !== undefined) {
    if (config.probeJitterRatio < 0 || config.probeJitterRatio > 1) {
      throw new Error(
        `AdaptiveLimiter: probeJitterRatio must be in [0, 1], got ${config.probeJitterRatio}`,
      );
    }
  }
  if (config.minSamples !== undefined && config.minSamples < 1) {
    throw new Error(
      `AdaptiveLimiter: minSamples must be >= 1, got ${config.minSamples}`,
    );
  }
  if (
    config.baselineStrategy !== undefined &&
    config.baselineStrategy !== "min" &&
    config.baselineStrategy !== "p5" &&
    config.baselineStrategy !== "ema-low"
  ) {
    throw new Error(
      `AdaptiveLimiter: baselineStrategy must be "min", "p5", or "ema-low", got ${config.baselineStrategy}`,
    );
  }
  if (
    config.decreaseCooldownSamples !== undefined &&
    (!Number.isFinite(config.decreaseCooldownSamples) || config.decreaseCooldownSamples < 0)
  ) {
    throw new Error(
      `AdaptiveLimiter: decreaseCooldownSamples must be >= 0, got ${config.decreaseCooldownSamples}`,
    );
  }
  if (
    config.historySize !== undefined &&
    (!Number.isFinite(config.historySize) || config.historySize < 0)
  ) {
    throw new Error(
      `AdaptiveLimiter: historySize must be >= 0, got ${config.historySize}`,
    );
  }
  if (config.windowDecayFactor !== undefined) {
    if (!Number.isFinite(config.windowDecayFactor) || config.windowDecayFactor <= 0 || config.windowDecayFactor > 1) {
      throw new Error(
        `AdaptiveLimiter: windowDecayFactor must be in (0, 1], got ${config.windowDecayFactor}`,
      );
    }
  }
  if (config.errorWeight !== undefined) {
    if (!Number.isFinite(config.errorWeight) || config.errorWeight < 0 || config.errorWeight > 1) {
      throw new Error(
        `AdaptiveLimiter: errorWeight must be in [0, 1], got ${config.errorWeight}`,
      );
    }
  }
  if (config.errorSmoothingFactor !== undefined) {
    if (!Number.isFinite(config.errorSmoothingFactor) || config.errorSmoothingFactor <= 0 || config.errorSmoothingFactor > 1) {
      throw new Error(
        `AdaptiveLimiter: errorSmoothingFactor must be in (0, 1], got ${config.errorSmoothingFactor}`,
      );
    }
  }
  if (config.errorStatusThreshold !== undefined) {
    if (!Number.isFinite(config.errorStatusThreshold) || config.errorStatusThreshold < 100 || config.errorStatusThreshold > 599) {
      throw new Error(
        `AdaptiveLimiter: errorStatusThreshold must be in [100, 599], got ${config.errorStatusThreshold}`,
      );
    }
  }
  if (
    config.queueStrategy !== undefined &&
    config.queueStrategy !== "fifo" &&
    config.queueStrategy !== "priority"
  ) {
    throw new Error(
      `AdaptiveLimiter: queueStrategy must be "fifo" or "priority", got ${config.queueStrategy}`,
    );
  }
  if (
    config.queueLoadShedding !== undefined &&
    config.queueLoadShedding !== "reject-new" &&
    config.queueLoadShedding !== "priority-evict"
  ) {
    throw new Error(
      `AdaptiveLimiter: queueLoadShedding must be "reject-new" or "priority-evict", got ${config.queueLoadShedding}`,
    );
  }
  if (
    config.rejectionBackoffThreshold !== undefined &&
    (!Number.isFinite(config.rejectionBackoffThreshold) || config.rejectionBackoffThreshold < 1)
  ) {
    throw new Error(
      `AdaptiveLimiter: rejectionBackoffThreshold must be >= 1, got ${config.rejectionBackoffThreshold}`,
    );
  }
  if (
    config.rejectionBackoffMs !== undefined &&
    (!Number.isFinite(config.rejectionBackoffMs) || config.rejectionBackoffMs < 1)
  ) {
    throw new Error(
      `AdaptiveLimiter: rejectionBackoffMs must be >= 1, got ${config.rejectionBackoffMs}`,
    );
  }
  if (config.stateTtlMs !== undefined && config.stateTtlMs !== false) {
    if (config.stateTtlMs < 1) {
      throw new Error(
        `AdaptiveLimiter: stateTtlMs must be >= 1ms or false, got ${config.stateTtlMs}`,
      );
    }
  }
  if (config.warmupRequests !== undefined && config.warmupRequests < 0) {
    throw new Error(
      `AdaptiveLimiter: warmupRequests must be >= 0, got ${config.warmupRequests}`,
    );
  }
  if (config.decreaseThreshold !== undefined) {
    if (config.decreaseThreshold <= 0 || config.decreaseThreshold > 1) {
      throw new Error(
        `AdaptiveLimiter: decreaseThreshold must be in (0, 1], got ${config.decreaseThreshold}`,
      );
    }
  }
  if (config.increaseThreshold !== undefined && config.increaseThreshold < 1) {
    throw new Error(
      `AdaptiveLimiter: increaseThreshold must be >= 1, got ${config.increaseThreshold}`,
    );
  }
  if (config.maxDecreaseRatio !== undefined) {
    if (config.maxDecreaseRatio <= 0 || config.maxDecreaseRatio > 1) {
      throw new Error(
        `AdaptiveLimiter: maxDecreaseRatio must be in (0, 1], got ${config.maxDecreaseRatio}`,
      );
    }
  }
  if (config.initialLimit !== undefined && config.initialLimit < 1) {
    throw new Error(
      `AdaptiveLimiter: initialLimit must be >= 1, got ${config.initialLimit}`,
    );
  }
  if (config.minLimit !== undefined && config.minLimit < 1) {
    throw new Error(
      `AdaptiveLimiter: minLimit must be >= 1, got ${config.minLimit}`,
    );
  }
  if (config.maxLimit !== undefined && config.maxLimit < 1) {
    throw new Error(
      `AdaptiveLimiter: maxLimit must be >= 1, got ${config.maxLimit}`,
    );
  }
  validateHeadroomStrategy(config.headroomStrategy);
  if (config.slowStartSaturationThreshold !== undefined) {
    if (config.slowStartSaturationThreshold <= 0 || config.slowStartSaturationThreshold > 1) {
      throw new Error(
        `AdaptiveLimiter: slowStartSaturationThreshold must be in (0, 1], got ${config.slowStartSaturationThreshold}`,
      );
    }
  }
  if (config.slowStartSaturationSamples !== undefined && config.slowStartSaturationSamples < 1) {
    throw new Error(
      `AdaptiveLimiter: slowStartSaturationSamples must be >= 1, got ${config.slowStartSaturationSamples}`,
    );
  }
}

function validatePositiveNumber(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`AdaptiveLimiter: ${name} must be > 0, got ${value}`);
  }
}

function validateHeadroomStrategy(strategy: AdaptiveHeadroomStrategy | undefined): void {
  if (strategy === undefined) return;
  if (typeof strategy === "function") return;
  if (typeof strategy === "number") {
    validatePositiveNumber("headroomStrategy", strategy);
    return;
  }
  if (strategy === "fixed" || strategy === "proportional") return;
  if (typeof strategy !== "object" || strategy === null) {
    throw new Error("AdaptiveLimiter: headroomStrategy must be a number, function, 'fixed', 'proportional', or strategy object");
  }
  if (strategy.type === "fixed") {
    validatePositiveNumber("headroomStrategy.value", strategy.value);
    return;
  }
  if (strategy.type === "proportional") {
    validatePositiveNumber("headroomStrategy.ratio", strategy.ratio);
    validatePositiveNumber("headroomStrategy.min", strategy.min);
    validatePositiveNumber("headroomStrategy.max", strategy.max);
    return;
  }
  throw new Error("AdaptiveLimiter: headroomStrategy.type must be 'fixed' or 'proportional'");
}

/** Default configuration values. */
const DEFAULTS: ResolvedConfig = {
  preset: undefined,
  initialLimit: 10,
  minLimit: 1,
  maxLimit: 200,
  smoothingFactor: 0.5,
  probeInterval: 10,
  probeJitterRatio: 0.2,
  windowSize: 100,
  minSamples: 10,
  baselineStrategy: "min",
  decreaseCooldownSamples: 0,
  historySize: 32,
  windowDecayFactor: 1,
  errorWeight: 0,
  errorSmoothingFactor: 0.5,
  errorStatusThreshold: 500,
  queueStrategy: "fifo",
  queueLoadShedding: "reject-new",
  rejectionBackoffThreshold: 3,
  rejectionBackoffMs: undefined,
  stateTtlMs: 300_000,
  warmupRequests: 0,
  decreaseThreshold: 0.75,
  increaseThreshold: 1.0,
  maxDecreaseRatio: 0.2,
  headroomStrategy: 1,
  slowStartRecovery: true,
  slowStartSaturationThreshold: 0.5,
  slowStartSaturationSamples: 3,
  key: "origin",
  maxQueue: 256,
  queueTimeoutMs: undefined,
  onLimitChange: undefined,
  percentile: "p50",
};

/**
 * Resolves a partial configuration into a fully-resolved configuration with defaults applied.
 * Handles minLimit > maxLimit by treating minLimit as the effective maxLimit.
 */
export function resolveConfig(config?: AdaptiveLimiterConfig): ResolvedConfig {
  if (!config) return DEFAULTS;

  validateConfig(config);
  const effectiveConfig: AdaptiveLimiterConfig = config.preset === undefined
    ? config
    : { ...adaptiveLimiterPresets[config.preset], ...config };

  let minLimit = effectiveConfig.minLimit ?? DEFAULTS.minLimit;
  let maxLimit = effectiveConfig.maxLimit ?? DEFAULTS.maxLimit;

  // If minLimit > maxLimit, treat minLimit as the effective maxLimit
  if (minLimit > maxLimit) {
    maxLimit = minLimit;
  }

  let initialLimit = effectiveConfig.initialLimit ?? DEFAULTS.initialLimit;
  // Clamp initial limit to bounds
  initialLimit = Math.max(minLimit, Math.min(maxLimit, initialLimit));
  const windowSize = Math.floor(effectiveConfig.windowSize ?? DEFAULTS.windowSize);
  const minSamples = Math.max(1, Math.min(Math.floor(effectiveConfig.minSamples ?? DEFAULTS.minSamples), windowSize));
  const decreaseCooldownSamples = Math.floor(effectiveConfig.decreaseCooldownSamples ?? DEFAULTS.decreaseCooldownSamples);
  const historySize = Math.floor(effectiveConfig.historySize ?? DEFAULTS.historySize);
  const errorSmoothingFactor = effectiveConfig.errorSmoothingFactor ?? effectiveConfig.smoothingFactor ?? DEFAULTS.smoothingFactor;
  const stateTtlMs = effectiveConfig.stateTtlMs === false
    ? undefined
    : Math.floor(effectiveConfig.stateTtlMs ?? DEFAULTS.stateTtlMs!);

  return {
    preset: effectiveConfig.preset,
    initialLimit,
    minLimit,
    maxLimit,
    smoothingFactor: effectiveConfig.smoothingFactor ?? DEFAULTS.smoothingFactor,
    probeInterval: Math.floor(effectiveConfig.probeInterval ?? DEFAULTS.probeInterval),
    probeJitterRatio: effectiveConfig.probeJitterRatio ?? DEFAULTS.probeJitterRatio,
    windowSize,
    minSamples,
    baselineStrategy: effectiveConfig.baselineStrategy ?? DEFAULTS.baselineStrategy,
    decreaseCooldownSamples,
    historySize,
    windowDecayFactor: effectiveConfig.windowDecayFactor ?? DEFAULTS.windowDecayFactor,
    errorWeight: effectiveConfig.errorWeight ?? DEFAULTS.errorWeight,
    errorSmoothingFactor,
    errorStatusThreshold: Math.floor(effectiveConfig.errorStatusThreshold ?? DEFAULTS.errorStatusThreshold),
    queueStrategy: effectiveConfig.queueStrategy ?? DEFAULTS.queueStrategy,
    queueLoadShedding: effectiveConfig.queueLoadShedding ?? DEFAULTS.queueLoadShedding,
    rejectionBackoffThreshold: Math.floor(effectiveConfig.rejectionBackoffThreshold ?? DEFAULTS.rejectionBackoffThreshold),
    rejectionBackoffMs: effectiveConfig.rejectionBackoffMs === undefined ? DEFAULTS.rejectionBackoffMs : Math.floor(effectiveConfig.rejectionBackoffMs),
    stateTtlMs,
    warmupRequests: Math.floor(effectiveConfig.warmupRequests ?? DEFAULTS.warmupRequests),
    decreaseThreshold: effectiveConfig.decreaseThreshold ?? DEFAULTS.decreaseThreshold,
    increaseThreshold: effectiveConfig.increaseThreshold ?? DEFAULTS.increaseThreshold,
    maxDecreaseRatio: effectiveConfig.maxDecreaseRatio ?? DEFAULTS.maxDecreaseRatio,
    headroomStrategy: effectiveConfig.headroomStrategy ?? DEFAULTS.headroomStrategy,
    slowStartRecovery: effectiveConfig.slowStartRecovery ?? DEFAULTS.slowStartRecovery,
    slowStartSaturationThreshold: effectiveConfig.slowStartSaturationThreshold ?? DEFAULTS.slowStartSaturationThreshold,
    slowStartSaturationSamples: Math.floor(effectiveConfig.slowStartSaturationSamples ?? DEFAULTS.slowStartSaturationSamples),
    key: effectiveConfig.key ?? DEFAULTS.key,
    maxQueue: effectiveConfig.maxQueue ?? DEFAULTS.maxQueue,
    queueTimeoutMs: effectiveConfig.queueTimeoutMs,
    onLimitChange: effectiveConfig.onLimitChange,
    percentile: effectiveConfig.percentile ?? DEFAULTS.percentile,
  };
}
