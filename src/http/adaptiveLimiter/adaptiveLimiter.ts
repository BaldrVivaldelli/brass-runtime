// src/http/adaptiveLimiter/adaptiveLimiter.ts

import type { HttpError } from "../client";
import type { HttpPoolKeyResolver } from "../pool";
import { LatencyWindow } from "./latencyWindow";
import { EmaComputer } from "./ema";
import { computeGradient, computeNewLimit } from "./gradient";
import {
  type AdaptiveLimiterConfig,
  type AdaptiveLimiterDiagnostics,
  type AdaptiveLimiterKeySnapshot,
  type AdaptiveLimiterStats,
  type AdaptiveLease,
  type AdaptiveHeadroomMode,
  type AdaptiveAcquireOptions,
  type AdaptiveReleaseInfo,
  type LimitChangeEvent,
  type ResolvedConfig,
  resolveConfig,
} from "./types";

type Waiter = {
  resolve: (lease: AdaptiveLease) => void;
  reject: (error: HttpError) => void;
  signal: AbortSignal;
  priority: number;
  arrivalOrder: number;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PerKeyState = {
  key: string;
  limit: number;
  inFlight: number;
  window: LatencyWindow;
  ema: EmaComputer;
  baselineEma: EmaComputer;
  errorEma: EmaComputer;
  probeCount: number;
  queue: Waiter[];
  lastGradient: number | undefined;
  lastLatencyGradient: number | undefined;
  acquired: number;
  released: number;
  rejected: number;
  queueTimeouts: number;
  abortedWhileQueued: number;
  evictedWhileQueued: number;
  rejectionStreak: number;
  queueSequence: number;
  createdAt: number;
  createdTimestamp: number;
  lastActivityAt: number;
  lastActivityTimestamp: number;
  ttlTimer?: ReturnType<typeof setTimeout>;
  nextProbeAt: number;
  warmupCompletions: number;
  warmupDone: boolean;
  saturationStreak: number;
  slowStartActive: boolean;
  slowStartRecoveryStarted: boolean;
  slowStartHeadroom: number;
  decreaseCooldownRemaining: number;
  history: LimitChangeEvent[];
};

const monotonicNow = (): number => {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
};

const wallNow = (): number => Date.now();

const DEFAULT_PRIORITY = 5;

const clampPriority = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PRIORITY;
  return Math.max(0, Math.min(9, Math.floor(value)));
};

const poolTimeoutError = (key: string, timeoutMs: number): HttpError => ({
  _tag: "PoolTimeout",
  key,
  timeoutMs,
  message: `Adaptive limiter '${key}' did not grant a slot within ${timeoutMs}ms`,
});

const poolRejectedError = (key: string, limit: number, retryAfterMs?: number): HttpError => ({
  _tag: "PoolRejected",
  key,
  limit,
  message: `Adaptive limiter '${key}' queue is full (max ${limit})`,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const abortError = (): HttpError => ({ _tag: "Abort" });

const poolClosedError = (key: string): HttpError => ({
  _tag: "PoolClosed",
  key,
  message: `Adaptive limiter '${key}' has been destroyed`,
});

/**
 * Adaptive concurrency limiter that dynamically adjusts the number of concurrent
 * requests based on observed latency patterns using a gradient-based algorithm.
 */
export class AdaptiveLimiter {
  private readonly config: ResolvedConfig;
  private readonly states = new Map<string, PerKeyState>();
  private destroyed = false;

  constructor(config?: AdaptiveLimiterConfig) {
    this.config = resolveConfig(config);
  }

  /** Key resolver for external use by the HTTP client. */
  get keyResolver(): HttpPoolKeyResolver | undefined {
    return this.config.key;
  }

  /**
   * Acquire a concurrency slot for the given key.
   * Resolves immediately if under the limit, otherwise queues the request.
   * Rejects with PoolRejected if the queue is full, or PoolTimeout if the queue timeout expires.
   */
  acquire(key: string, signal: AbortSignal, options?: AdaptiveAcquireOptions): Promise<AdaptiveLease> {
    if (this.destroyed) return Promise.reject(poolClosedError(key));
    const state = this.getOrCreateState(key);
    this.touch(state);
    const priority = clampPriority(options?.priority);

    if (signal.aborted) {
      this.scheduleIdleEviction(state);
      return Promise.reject(abortError());
    }

    if (state.inFlight < state.limit) {
      state.inFlight++;
      state.acquired++;
      state.rejectionStreak = 0;
      return Promise.resolve(this.makeLease(state));
    }

    if (state.queue.length >= this.config.maxQueue) {
      const evicted = this.tryEvictLowerPriorityWaiter(state, priority);
      if (!evicted) {
        state.rejected++;
        state.rejectionStreak++;
        this.scheduleIdleEviction(state);
        return Promise.reject(poolRejectedError(key, this.config.maxQueue, this.suggestedBackoffMs(state)));
      }
    }

    return new Promise<AdaptiveLease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        priority,
        arrivalOrder: state.queueSequence++,
      };
      const removeWaiter = () => this.removeWaiter(state, waiter);
      const cleanup = () => this.cleanupWaiter(waiter);

      waiter.abort = () => {
        cleanup();
        removeWaiter();
        this.touch(state);
        state.abortedWhileQueued++;
        this.scheduleIdleEviction(state);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.abort, { once: true });

      if (this.config.queueTimeoutMs !== undefined && this.config.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          removeWaiter();
          this.touch(state);
          state.queueTimeouts++;
          this.scheduleIdleEviction(state);
          reject(poolTimeoutError(key, this.config.queueTimeoutMs!));
        }, this.config.queueTimeoutMs);
      }

      this.enqueueWaiter(state, waiter);
    });
  }

  /**
   * Get stats for a specific key, or aggregate stats if no key is provided.
   */
  stats(key?: string): AdaptiveLimiterStats {
    this.evictIdleStates();

    if (key !== undefined) {
      const state = this.states.get(key);
      if (!state) {
        return {
          limit: this.config.initialLimit,
          inFlight: 0,
          queueDepth: 0,
          gradient: undefined,
          latencyGradient: undefined,
          errorRate: undefined,
          smoothedLatency: undefined,
          minLatency: undefined,
          baselineLatency: undefined,
          p5: undefined,
          p50: undefined,
          p99: undefined,
          probeCount: 0,
          windowSize: 0,
          warmupCompletions: 0,
          slowStart: false,
          cooldownSamplesRemaining: 0,
          utilization: 0,
          requestsPerSecond: 0,
          completionsPerSecond: 0,
          rejectionRate: 0,
          suggestedBackoffMs: undefined,
        };
      }
      return this.stateToStats(state);
    }

    // Aggregate across all keys
    if (this.states.size === 0) {
      return {
        limit: this.config.initialLimit,
        inFlight: 0,
        queueDepth: 0,
        gradient: undefined,
        latencyGradient: undefined,
        errorRate: undefined,
        smoothedLatency: undefined,
        minLatency: undefined,
        baselineLatency: undefined,
        p5: undefined,
        p50: undefined,
        p99: undefined,
        probeCount: 0,
        windowSize: 0,
        warmupCompletions: 0,
        slowStart: false,
        cooldownSamplesRemaining: 0,
        utilization: 0,
        requestsPerSecond: 0,
        completionsPerSecond: 0,
        rejectionRate: 0,
        suggestedBackoffMs: undefined,
        stateCount: 0,
        keys: [],
      };
    }

    // If only one key, return its stats directly
    if (this.states.size === 1) {
      const [state] = this.states.values();
      return {
        ...this.stateToStats(state!),
        keys: [state!.key],
      };
    }

    // Aggregate: sum limits, inFlight, queueDepth; use first key's gradient info
    let totalLimit = 0;
    let totalInFlight = 0;
    let totalQueueDepth = 0;
    let totalProbeCount = 0;
    let totalWindowSize = 0;
    let totalRequestsPerSecond = 0;
    let totalCompletionsPerSecond = 0;
    let totalRejected = 0;
    let totalAttempts = 0;
    const keys: string[] = [];
    let firstState: PerKeyState | undefined;
    const now = monotonicNow();

    for (const state of this.states.values()) {
      keys.push(state.key);
      totalLimit += state.limit;
      totalInFlight += state.inFlight;
      totalQueueDepth += state.queue.length;
      totalProbeCount += state.probeCount;
      totalWindowSize += state.window.length;
      const stats = this.stateToStats(state, now);
      totalRequestsPerSecond += stats.requestsPerSecond ?? 0;
      totalCompletionsPerSecond += stats.completionsPerSecond ?? 0;
      totalRejected += state.rejected;
      totalAttempts += state.acquired + state.rejected + state.queueTimeouts + state.abortedWhileQueued;
      if (!firstState) firstState = state;
    }

    const minLatency = firstState?.window.min();
    return {
      limit: totalLimit,
      inFlight: totalInFlight,
      queueDepth: totalQueueDepth,
      gradient: firstState?.lastGradient,
      latencyGradient: firstState?.lastLatencyGradient,
      errorRate: firstState?.errorEma.value,
      smoothedLatency: firstState?.ema.value,
      minLatency,
      baselineLatency: minLatency === undefined || firstState === undefined
        ? undefined
        : this.baselineLatency(firstState, minLatency),
      p5: firstState === undefined ? undefined : this.windowPercentile(firstState, 5),
      p50: firstState === undefined ? undefined : this.windowPercentile(firstState, 50),
      p99: firstState === undefined ? undefined : this.windowPercentile(firstState, 99),
      probeCount: totalProbeCount,
      windowSize: totalWindowSize,
      warmupCompletions: firstState?.warmupCompletions ?? 0,
      slowStart: firstState?.slowStartActive ?? false,
      cooldownSamplesRemaining: firstState?.decreaseCooldownRemaining ?? 0,
      utilization: totalLimit > 0 ? totalInFlight / totalLimit : 0,
      requestsPerSecond: totalRequestsPerSecond,
      completionsPerSecond: totalCompletionsPerSecond,
      rejectionRate: totalAttempts > 0 ? totalRejected / totalAttempts : 0,
      suggestedBackoffMs: firstState === undefined ? undefined : this.suggestedBackoffMs(firstState),
      stateCount: this.states.size,
      keys,
    };
  }

  /** Return the currently retained per-key state identifiers. */
  keys(): readonly string[] {
    this.evictIdleStates();
    return [...this.states.keys()];
  }

  /** Return a diagnostic snapshot for one retained key, if present. */
  snapshot(key: string): AdaptiveLimiterKeySnapshot | undefined {
    this.evictIdleStates();
    const state = this.states.get(key);
    return state ? this.stateToKeySnapshot(state) : undefined;
  }

  /** Return a full diagnostic dump across all retained keys. */
  dump(): AdaptiveLimiterDiagnostics {
    this.evictIdleStates();
    const keys = [...this.states.keys()];
    return {
      stateCount: this.states.size,
      keys,
      aggregate: this.stats(),
      states: [...this.states.values()].map((state) => this.stateToKeySnapshot(state)),
      history: this.history(),
    };
  }

  /** Return retained limit-change history for one key, or all keys if omitted. */
  history(key?: string): readonly LimitChangeEvent[] {
    this.evictIdleStates();
    if (key !== undefined) {
      return [...(this.states.get(key)?.history ?? [])];
    }
    return [...this.states.values()]
      .flatMap((state) => state.history)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Circuit-breaker feedback hook. When a circuit is already open for `key`,
   * collapse that key's limit to minLimit immediately instead of waiting for
   * latency gradients to discover the saturation indirectly.
   */
  markCircuitOpen(key: string): void {
    if (this.destroyed) return;
    const state = this.getOrCreateState(key);
    this.touch(state);
    state.saturationStreak = this.config.slowStartSaturationSamples;
    state.slowStartActive = this.config.slowStartRecovery;
    state.slowStartRecoveryStarted = false;
    state.slowStartHeadroom = Math.max(1, this.resolveHeadroom(state, 0, "circuit-open"));
    const minLatency = state.window.min() ?? 0;
    this.applyLimit(
      state,
      this.config.minLimit,
      0,
      0,
      state.errorEma.value ?? 0,
      state.ema.value ?? 0,
      minLatency,
      state.baselineEma.value ?? minLatency,
      "circuit-open",
    );
    this.scheduleIdleEviction(state);
  }

  /** Destroy the limiter, reject queued waiters, clear timers, and drop state. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const state of this.states.values()) {
      this.clearIdleTimer(state);
      for (const waiter of state.queue.splice(0)) {
        this.cleanupWaiter(waiter);
        waiter.reject(poolClosedError(state.key));
      }
      state.inFlight = 0;
    }
    this.states.clear();
  }

  /** Alias for destroy(), useful for graceful shutdown code paths. */
  shutdown(): void {
    this.destroy();
  }

  private getOrCreateState(key: string): PerKeyState {
    const existing = this.states.get(key);
    if (existing) return existing;

    const now = monotonicNow();
    const timestamp = wallNow();
    const state: PerKeyState = {
      key,
      limit: this.config.initialLimit,
      inFlight: 0,
      window: new LatencyWindow(this.config.windowSize),
      ema: new EmaComputer(this.config.smoothingFactor),
      baselineEma: new EmaComputer(this.config.smoothingFactor),
      errorEma: new EmaComputer(this.config.errorSmoothingFactor),
      probeCount: 0,
      queue: [],
      lastGradient: undefined,
      lastLatencyGradient: undefined,
      acquired: 0,
      released: 0,
      rejected: 0,
      queueTimeouts: 0,
      abortedWhileQueued: 0,
      evictedWhileQueued: 0,
      rejectionStreak: 0,
      queueSequence: 0,
      createdAt: now,
      createdTimestamp: timestamp,
      lastActivityAt: now,
      lastActivityTimestamp: timestamp,
      nextProbeAt: this.nextProbeInterval(),
      warmupCompletions: 0,
      warmupDone: this.config.warmupRequests <= 0,
      saturationStreak: 0,
      slowStartActive: false,
      slowStartRecoveryStarted: false,
      slowStartHeadroom: 1,
      decreaseCooldownRemaining: 0,
      history: [],
    };
    this.states.set(key, state);
    this.scheduleIdleEviction(state);
    return state;
  }

  private makeLease(state: PerKeyState): AdaptiveLease {
    let released = false;
    return {
      key: state.key,
      release: (latencyMs: number, info?: AdaptiveReleaseInfo) => {
        if (released) return;
        released = true;
        if (this.destroyed) return;
        this.touch(state);
        if (state.inFlight > 0) state.inFlight--;
        state.released++;
        this.recordAndAdjust(state, latencyMs, info);
        this.drain(state);
        this.scheduleIdleEviction(state);
      },
    };
  }

  private recordAndAdjust(state: PerKeyState, latencyMs: number, info?: AdaptiveReleaseInfo): void {
    // Record latency in window (window discards invalid values)
    state.window.record(latencyMs);
    state.errorEma.update(this.isErrorSignal(info) ? 1 : 0);

    // Update EMAs
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      state.ema.update(latencyMs);
      state.baselineEma.update(this.lowLatencySample(state, latencyMs));
    }

    // If window is empty (no valid samples), don't adjust
    const minLat = state.window.min();
    const emaValue = state.ema.value;
    if (minLat === undefined || emaValue === undefined) return;

    const currentLatency = this.currentLatency(state, emaValue);
    if (currentLatency === undefined) return;

    // Compute gradient
    const baselineLatency = this.baselineLatency(state, minLat);
    const latencyGradient = computeGradient(baselineLatency, currentLatency);
    const gradient = this.combineGradientWithErrors(latencyGradient, state.errorEma.value ?? 0);
    state.lastGradient = gradient;
    state.lastLatencyGradient = latencyGradient;
    this.recordSaturation(state, gradient);

    if (this.tryWarmup(
      state,
      gradient,
      latencyGradient,
      state.errorEma.value ?? 0,
      emaValue,
      minLat,
      baselineLatency,
    )) return;
    if (state.window.length < this.config.minSamples) return;

    // Compute new limit
    const mode: AdaptiveHeadroomMode =
      state.slowStartActive && gradient >= this.config.increaseThreshold
        ? "slow-start"
        : "stable";
    let headroom = this.resolveHeadroom(state, gradient, mode);
    if (mode === "slow-start") {
      headroom = Math.max(headroom, state.slowStartHeadroom);
    }

    const cooldownActive = state.decreaseCooldownRemaining > 0;
    if (cooldownActive) state.decreaseCooldownRemaining--;

    const wantsDecrease = gradient < this.config.decreaseThreshold;
    const decreaseBlockedByCooldown = wantsDecrease && cooldownActive;
    let newLimit = decreaseBlockedByCooldown
      ? state.limit
      : computeNewLimit(
          state.limit,
          gradient,
          headroom,
          this.config.minLimit,
          this.config.maxLimit,
          {
            decreaseThreshold: this.config.decreaseThreshold,
            increaseThreshold: this.config.increaseThreshold,
            maxDecreaseRatio: this.config.maxDecreaseRatio,
          },
        );
    let reason: LimitChangeEvent["reason"] = mode === "slow-start" ? "slow-start" : "gradient";

    // Probe logic
    if (!decreaseBlockedByCooldown) state.probeCount++;
    if (!decreaseBlockedByCooldown && state.probeCount >= state.nextProbeAt) {
      const probeHeadroom = this.resolveHeadroom(state, gradient, "probe");
      newLimit = Math.min(newLimit + probeHeadroom, this.config.maxLimit);
      state.probeCount = 0;
      state.nextProbeAt = this.nextProbeInterval();
      reason = "probe";
    }

    const previousLimit = state.limit;
    this.applyLimit(state, newLimit, gradient, latencyGradient, state.errorEma.value ?? 0, emaValue, minLat, baselineLatency, reason);
    if (state.limit < previousLimit) {
      state.decreaseCooldownRemaining = this.config.decreaseCooldownSamples;
    }

    if (gradient < this.config.decreaseThreshold) {
      if (state.slowStartRecoveryStarted) {
        state.slowStartActive = false;
        state.slowStartRecoveryStarted = false;
        state.slowStartHeadroom = 1;
      }
    } else if (
      state.slowStartActive &&
      gradient >= this.config.increaseThreshold &&
      state.limit > previousLimit
    ) {
      state.slowStartRecoveryStarted = true;
      state.slowStartHeadroom = Math.max(
        1,
        Math.min(this.config.maxLimit, Math.ceil(headroom * 2)),
      );
    }
  }

  private tryWarmup(
    state: PerKeyState,
    gradient: number,
    latencyGradient: number,
    errorRate: number,
    emaValue: number,
    minLat: number,
    baselineLatency: number,
  ): boolean {
    if (state.warmupDone) return false;

    state.warmupCompletions++;
    if (gradient < this.config.decreaseThreshold) {
      state.warmupDone = true;
      return false;
    }

    const progress = Math.min(state.warmupCompletions, this.config.warmupRequests) / this.config.warmupRequests;
    const target = Math.ceil(
      this.config.initialLimit + (this.config.maxLimit - this.config.initialLimit) * progress,
    );
    const warmupHeadroom = this.resolveHeadroom(state, gradient, "warmup");
    const newLimit = Math.max(
      state.limit,
      Math.min(this.config.maxLimit, Math.max(target, state.limit + warmupHeadroom)),
    );

    if (state.warmupCompletions >= this.config.warmupRequests) {
      state.warmupDone = true;
    }

    this.applyLimit(state, newLimit, gradient, latencyGradient, errorRate, emaValue, minLat, baselineLatency, "warmup");
    return true;
  }

  private baselineLatency(state: PerKeyState, minLatency: number): number {
    if (this.config.baselineStrategy === "p5") {
      return this.windowPercentile(state, 5) ?? minLatency;
    }
    if (this.config.baselineStrategy === "ema-low") {
      return state.baselineEma.value ?? this.windowPercentile(state, 5) ?? minLatency;
    }
    return minLatency;
  }

  private lowLatencySample(state: PerKeyState, fallback: number): number {
    return this.windowPercentile(state, 5) ?? state.window.min() ?? fallback;
  }

  private isErrorSignal(info: AdaptiveReleaseInfo | undefined): boolean {
    if (!info) return false;
    if (info.error) return true;
    return info.status !== undefined && info.status >= this.config.errorStatusThreshold;
  }

  private combineGradientWithErrors(latencyGradient: number, errorRate: number): number {
    if (this.config.errorWeight <= 0 || errorRate <= 0) return latencyGradient;
    const errorGradient = 1 - Math.min(1, errorRate * this.config.errorWeight);
    return Math.max(0, Math.min(latencyGradient, errorGradient));
  }

  private windowPercentile(state: PerKeyState, percentile: number): number | undefined {
    return this.config.windowDecayFactor < 1
      ? state.window.weightedPercentile(percentile, this.config.windowDecayFactor)
      : state.window.percentile(percentile);
  }

  private recordSaturation(state: PerKeyState, gradient: number): void {
    if (!this.config.slowStartRecovery) return;
    if (gradient <= this.config.slowStartSaturationThreshold) {
      state.saturationStreak++;
      if (state.saturationStreak >= this.config.slowStartSaturationSamples) {
        state.slowStartActive = true;
        state.slowStartRecoveryStarted = false;
        state.slowStartHeadroom = Math.max(1, this.resolveHeadroom(state, gradient, "slow-start"));
      }
      return;
    }
    if (gradient >= this.config.increaseThreshold) {
      state.saturationStreak = 0;
    }
  }

  private applyLimit(
    state: PerKeyState,
    proposedLimit: number,
    gradient: number,
    latencyGradient: number,
    errorRate: number,
    smoothedLatency: number,
    minLatency: number,
    baselineLatency: number,
    reason: LimitChangeEvent["reason"],
  ): void {
    const newLimit = Math.max(this.config.minLimit, Math.min(this.config.maxLimit, Math.floor(proposedLimit)));
    if (newLimit === state.limit) {
      state.limit = newLimit;
      return;
    }

    const previousLimit = state.limit;
    state.limit = newLimit;

    const event: LimitChangeEvent = {
      key: state.key,
      previousLimit,
      newLimit,
      gradient,
      latencyGradient,
      errorRate,
      smoothedLatency,
      minLatency,
      baselineLatency,
      p5: this.windowPercentile(state, 5),
      timestamp: wallNow(),
      reason,
    };
    this.recordLimitChange(state, event);
    if (this.config.onLimitChange) {
      this.config.onLimitChange(event);
    }
  }

  private recordLimitChange(state: PerKeyState, event: LimitChangeEvent): void {
    if (this.config.historySize <= 0) return;
    state.history.push(event);
    if (state.history.length > this.config.historySize) {
      state.history.splice(0, state.history.length - this.config.historySize);
    }
  }

  private resolveHeadroom(
    state: PerKeyState,
    gradient: number,
    mode: AdaptiveHeadroomMode,
  ): number {
    const strategy = this.config.headroomStrategy;
    let value: number;

    if (typeof strategy === "function") {
      value = strategy({
        key: state.key,
        currentLimit: state.limit,
        minLimit: this.config.minLimit,
        maxLimit: this.config.maxLimit,
        gradient,
        mode,
      });
    } else if (typeof strategy === "number") {
      value = strategy;
    } else if (strategy === "proportional") {
      value = Math.ceil(state.limit * 0.05);
    } else if (strategy === "fixed") {
      value = 1;
    } else if (strategy.type === "proportional") {
      const ratio = strategy.ratio ?? 0.05;
      const min = strategy.min ?? 1;
      const max = strategy.max ?? Number.POSITIVE_INFINITY;
      value = Math.max(min, Math.min(max, Math.ceil(state.limit * ratio)));
    } else {
      value = strategy.value ?? 1;
    }

    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.max(1, Math.ceil(value));
  }

  private nextProbeInterval(): number {
    const base = this.config.probeInterval;
    const jitter = this.config.probeJitterRatio;
    if (jitter <= 0) return base;
    const spread = base * jitter;
    const min = Math.max(1, base - spread);
    const max = base + spread;
    return Math.max(1, Math.round(min + Math.random() * (max - min)));
  }

  private enqueueWaiter(state: PerKeyState, waiter: Waiter): void {
    state.queue.push(waiter);
  }

  private dequeueWaiter(state: PerKeyState): Waiter | undefined {
    if (state.queue.length === 0) return undefined;
    if (this.config.queueStrategy === "fifo") return state.queue.shift();

    let bestIdx = 0;
    for (let i = 1; i < state.queue.length; i++) {
      const candidate = state.queue[i]!;
      const best = state.queue[bestIdx]!;
      if (
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.arrivalOrder < best.arrivalOrder)
      ) {
        bestIdx = i;
      }
    }
    return state.queue.splice(bestIdx, 1)[0];
  }

  private tryEvictLowerPriorityWaiter(state: PerKeyState, newPriority: number): boolean {
    if (this.config.queueLoadShedding !== "priority-evict" || state.queue.length === 0) {
      return false;
    }

    let evictIdx = -1;
    for (let i = 0; i < state.queue.length; i++) {
      const candidate = state.queue[i]!;
      if (candidate.priority <= newPriority) continue;
      if (evictIdx < 0) {
        evictIdx = i;
        continue;
      }
      const current = state.queue[evictIdx]!;
      if (
        candidate.priority > current.priority ||
        (candidate.priority === current.priority && candidate.arrivalOrder > current.arrivalOrder)
      ) {
        evictIdx = i;
      }
    }

    if (evictIdx < 0) return false;
    const [evicted] = state.queue.splice(evictIdx, 1);
    if (!evicted) return false;
    this.cleanupWaiter(evicted);
    state.evictedWhileQueued++;
    state.rejected++;
    state.rejectionStreak++;
    evicted.reject(poolRejectedError(state.key, this.config.maxQueue, this.suggestedBackoffMs(state)));
    return true;
  }

  private suggestedBackoffMs(state: PerKeyState): number | undefined {
    if (this.config.rejectionBackoffMs === undefined) return undefined;
    if (state.rejectionStreak < this.config.rejectionBackoffThreshold) return undefined;
    const multiplier = Math.min(8, Math.max(1, state.rejectionStreak - this.config.rejectionBackoffThreshold + 1));
    return this.config.rejectionBackoffMs * multiplier;
  }

  private drain(state: PerKeyState): void {
    while (state.inFlight < state.limit && state.queue.length > 0) {
      const waiter = this.dequeueWaiter(state)!;
      this.cleanupWaiter(waiter);
      if (waiter.signal.aborted) {
        this.touch(state);
        state.abortedWhileQueued++;
        waiter.reject(abortError());
        continue;
      }
      this.touch(state);
      state.inFlight++;
      state.acquired++;
      state.rejectionStreak = 0;
      waiter.resolve(this.makeLease(state));
    }
  }

  private currentLatency(state: PerKeyState, emaValue: number): number | undefined {
    const percentileLatency = this.config.percentile === "p99"
      ? this.windowPercentile(state, 99)
      : this.windowPercentile(state, 50);
    return percentileLatency ?? emaValue;
  }

  private touch(state: PerKeyState): void {
    state.lastActivityAt = monotonicNow();
    state.lastActivityTimestamp = wallNow();
    this.clearIdleTimer(state);
  }

  private scheduleIdleEviction(state: PerKeyState): void {
    if (this.destroyed || this.config.stateTtlMs === undefined) return;
    this.clearIdleTimer(state);
    if (state.inFlight > 0 || state.queue.length > 0) return;

    const delay = Math.max(1, this.config.stateTtlMs - (monotonicNow() - state.lastActivityAt));
    state.ttlTimer = setTimeout(() => {
      state.ttlTimer = undefined;
      this.evictIdleState(state, monotonicNow());
    }, delay);
    (state.ttlTimer as any)?.unref?.();
  }

  private clearIdleTimer(state: PerKeyState): void {
    if (state.ttlTimer !== undefined) {
      clearTimeout(state.ttlTimer);
      state.ttlTimer = undefined;
    }
  }

  private evictIdleStates(): void {
    if (this.config.stateTtlMs === undefined) return;
    const now = monotonicNow();
    for (const state of Array.from(this.states.values())) {
      this.evictIdleState(state, now);
    }
  }

  private evictIdleState(state: PerKeyState, now: number): void {
    if (this.config.stateTtlMs === undefined) return;
    if (state.inFlight > 0 || state.queue.length > 0) {
      this.scheduleIdleEviction(state);
      return;
    }
    if (now - state.lastActivityAt < this.config.stateTtlMs) {
      this.scheduleIdleEviction(state);
      return;
    }
    this.clearIdleTimer(state);
    this.states.delete(state.key);
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.abort = undefined;
    }
  }

  private removeWaiter(state: PerKeyState, waiter: Waiter): void {
    const idx = state.queue.indexOf(waiter);
    if (idx >= 0) state.queue.splice(idx, 1);
  }

  private stateToStats(state: PerKeyState, now = monotonicNow()): AdaptiveLimiterStats {
    const minLatency = state.window.min();
    const elapsedSeconds = Math.max((now - state.createdAt) / 1000, 0.001);
    const attempts = state.acquired + state.rejected + state.queueTimeouts + state.abortedWhileQueued;
    return {
      limit: state.limit,
      inFlight: state.inFlight,
      queueDepth: state.queue.length,
      gradient: state.lastGradient,
      latencyGradient: state.lastLatencyGradient,
      errorRate: state.errorEma.value,
      smoothedLatency: state.ema.value,
      minLatency,
      baselineLatency: minLatency === undefined ? undefined : this.baselineLatency(state, minLatency),
      p5: this.windowPercentile(state, 5),
      p50: this.windowPercentile(state, 50),
      p99: this.windowPercentile(state, 99),
      probeCount: state.probeCount,
      windowSize: state.window.length,
      warmupCompletions: state.warmupCompletions,
      slowStart: state.slowStartActive,
      cooldownSamplesRemaining: state.decreaseCooldownRemaining,
      utilization: state.limit > 0 ? state.inFlight / state.limit : 0,
      requestsPerSecond: state.acquired / elapsedSeconds,
      completionsPerSecond: state.released / elapsedSeconds,
      rejectionRate: attempts > 0 ? state.rejected / attempts : 0,
      suggestedBackoffMs: this.suggestedBackoffMs(state),
      stateCount: this.states.size,
    };
  }

  private stateToKeySnapshot(state: PerKeyState): AdaptiveLimiterKeySnapshot {
    return {
      ...this.stateToStats(state),
      key: state.key,
      createdAt: state.createdAt,
      createdTimestamp: state.createdTimestamp,
      lastActivityAt: state.lastActivityAt,
      lastActivityTimestamp: state.lastActivityTimestamp,
      nextProbeAt: state.nextProbeAt,
      warmupDone: state.warmupDone,
      saturationStreak: state.saturationStreak,
      slowStartRecoveryStarted: state.slowStartRecoveryStarted,
      history: [...state.history],
      acquired: state.acquired,
      released: state.released,
      rejected: state.rejected,
      queueTimeouts: state.queueTimeouts,
      abortedWhileQueued: state.abortedWhileQueued,
      evictedWhileQueued: state.evictedWhileQueued,
    };
  }
}
