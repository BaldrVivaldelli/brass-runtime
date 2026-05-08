// src/http/adaptiveLimiter/types.ts

import type { HttpPoolKeyResolver } from "../pool";

/**
 * Configuration for the adaptive concurrency limiter.
 * All fields are optional with sensible defaults.
 */
export type AdaptiveLimiterConfig = {
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
  /** Sliding window size for latency samples. Default: 100. */
  readonly windowSize?: number;
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
  readonly smoothedLatency: number;
  readonly minLatency: number;
  readonly timestamp: number;
};

/**
 * Snapshot of the adaptive limiter's current state for a given key.
 */
export type AdaptiveLimiterStats = {
  readonly limit: number;
  readonly inFlight: number;
  readonly queueDepth: number;
  readonly gradient: number | undefined;
  readonly smoothedLatency: number | undefined;
  readonly minLatency: number | undefined;
  readonly p50: number | undefined;
  readonly p99: number | undefined;
  readonly probeCount: number;
  readonly windowSize: number;
};

/**
 * A lease representing an acquired concurrency slot.
 * Call `release(latencyMs)` when the request completes to record latency and free the slot.
 */
export type AdaptiveLease = {
  readonly key: string;
  release(latencyMs: number): void;
};

/** Resolved (non-optional) configuration with defaults applied. */
export type ResolvedConfig = {
  readonly initialLimit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly smoothingFactor: number;
  readonly probeInterval: number;
  readonly windowSize: number;
  readonly key: HttpPoolKeyResolver;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number | undefined;
  readonly onLimitChange: ((event: LimitChangeEvent) => void) | undefined;
  readonly percentile: "p50" | "p99";
};

/**
 * Validates the adaptive limiter configuration.
 * Throws a descriptive error for invalid combinations.
 */
export function validateConfig(config: AdaptiveLimiterConfig): void {
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
}

/** Default configuration values. */
const DEFAULTS: ResolvedConfig = {
  initialLimit: 10,
  minLimit: 1,
  maxLimit: 200,
  smoothingFactor: 0.5,
  probeInterval: 10,
  windowSize: 100,
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

  let minLimit = config.minLimit ?? DEFAULTS.minLimit;
  let maxLimit = config.maxLimit ?? DEFAULTS.maxLimit;

  // If minLimit > maxLimit, treat minLimit as the effective maxLimit
  if (minLimit > maxLimit) {
    maxLimit = minLimit;
  }

  let initialLimit = config.initialLimit ?? DEFAULTS.initialLimit;
  // Clamp initial limit to bounds
  initialLimit = Math.max(minLimit, Math.min(maxLimit, initialLimit));

  return {
    initialLimit,
    minLimit,
    maxLimit,
    smoothingFactor: config.smoothingFactor ?? DEFAULTS.smoothingFactor,
    probeInterval: config.probeInterval ?? DEFAULTS.probeInterval,
    windowSize: config.windowSize ?? DEFAULTS.windowSize,
    key: config.key ?? DEFAULTS.key,
    maxQueue: config.maxQueue ?? DEFAULTS.maxQueue,
    queueTimeoutMs: config.queueTimeoutMs,
    onLimitChange: config.onLimitChange,
    percentile: config.percentile ?? DEFAULTS.percentile,
  };
}
