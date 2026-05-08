// src/http/adaptiveLimiter/adaptiveLimiter.ts

import type { HttpError } from "../client";
import type { HttpPoolKeyResolver } from "../pool";
import { LatencyWindow } from "./latencyWindow";
import { EmaComputer } from "./ema";
import { computeGradient, computeNewLimit } from "./gradient";
import {
  type AdaptiveLimiterConfig,
  type AdaptiveLimiterStats,
  type AdaptiveLease,
  type LimitChangeEvent,
  type ResolvedConfig,
  resolveConfig,
} from "./types";

type Waiter = {
  resolve: (lease: AdaptiveLease) => void;
  reject: (error: HttpError) => void;
  signal: AbortSignal;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PerKeyState = {
  key: string;
  limit: number;
  inFlight: number;
  window: LatencyWindow;
  ema: EmaComputer;
  probeCount: number;
  queue: Waiter[];
  lastGradient: number | undefined;
  acquired: number;
  released: number;
  rejected: number;
  queueTimeouts: number;
  abortedWhileQueued: number;
};

const poolTimeoutError = (key: string, timeoutMs: number): HttpError => ({
  _tag: "PoolTimeout",
  key,
  timeoutMs,
  message: `Adaptive limiter '${key}' did not grant a slot within ${timeoutMs}ms`,
});

const poolRejectedError = (key: string, limit: number): HttpError => ({
  _tag: "PoolRejected",
  key,
  limit,
  message: `Adaptive limiter '${key}' queue is full (max ${limit})`,
});

const abortError = (): HttpError => ({ _tag: "Abort" });

/**
 * Adaptive concurrency limiter that dynamically adjusts the number of concurrent
 * requests based on observed latency patterns using a gradient-based algorithm.
 */
export class AdaptiveLimiter {
  private readonly config: ResolvedConfig;
  private readonly states = new Map<string, PerKeyState>();

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
  acquire(key: string, signal: AbortSignal): Promise<AdaptiveLease> {
    const state = this.getOrCreateState(key);

    if (signal.aborted) return Promise.reject(abortError());

    if (state.inFlight < state.limit) {
      state.inFlight++;
      state.acquired++;
      return Promise.resolve(this.makeLease(state));
    }

    if (state.queue.length >= this.config.maxQueue) {
      state.rejected++;
      return Promise.reject(poolRejectedError(key, this.config.maxQueue));
    }

    return new Promise<AdaptiveLease>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      const removeWaiter = () => this.removeWaiter(state, waiter);
      const cleanup = () => this.cleanupWaiter(waiter);

      waiter.abort = () => {
        cleanup();
        removeWaiter();
        state.abortedWhileQueued++;
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.abort, { once: true });

      if (this.config.queueTimeoutMs !== undefined && this.config.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          removeWaiter();
          state.queueTimeouts++;
          reject(poolTimeoutError(key, this.config.queueTimeoutMs!));
        }, this.config.queueTimeoutMs);
      }

      state.queue.push(waiter);
    });
  }

  /**
   * Get stats for a specific key, or aggregate stats if no key is provided.
   */
  stats(key?: string): AdaptiveLimiterStats {
    if (key !== undefined) {
      const state = this.states.get(key);
      if (!state) {
        return {
          limit: this.config.initialLimit,
          inFlight: 0,
          queueDepth: 0,
          gradient: undefined,
          smoothedLatency: undefined,
          minLatency: undefined,
          p50: undefined,
          p99: undefined,
          probeCount: 0,
          windowSize: 0,
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
        smoothedLatency: undefined,
        minLatency: undefined,
        p50: undefined,
        p99: undefined,
        probeCount: 0,
        windowSize: 0,
      };
    }

    // If only one key, return its stats directly
    if (this.states.size === 1) {
      const [state] = this.states.values();
      return this.stateToStats(state!);
    }

    // Aggregate: sum limits, inFlight, queueDepth; use first key's gradient info
    let totalLimit = 0;
    let totalInFlight = 0;
    let totalQueueDepth = 0;
    let totalProbeCount = 0;
    let totalWindowSize = 0;
    let firstState: PerKeyState | undefined;

    for (const state of this.states.values()) {
      totalLimit += state.limit;
      totalInFlight += state.inFlight;
      totalQueueDepth += state.queue.length;
      totalProbeCount += state.probeCount;
      totalWindowSize += state.window.length;
      if (!firstState) firstState = state;
    }

    return {
      limit: totalLimit,
      inFlight: totalInFlight,
      queueDepth: totalQueueDepth,
      gradient: firstState?.lastGradient,
      smoothedLatency: firstState?.ema.value,
      minLatency: firstState?.window.min(),
      p50: firstState?.window.percentile(50),
      p99: firstState?.window.percentile(99),
      probeCount: totalProbeCount,
      windowSize: totalWindowSize,
    };
  }

  private getOrCreateState(key: string): PerKeyState {
    const existing = this.states.get(key);
    if (existing) return existing;

    const state: PerKeyState = {
      key,
      limit: this.config.initialLimit,
      inFlight: 0,
      window: new LatencyWindow(this.config.windowSize),
      ema: new EmaComputer(this.config.smoothingFactor),
      probeCount: 0,
      queue: [],
      lastGradient: undefined,
      acquired: 0,
      released: 0,
      rejected: 0,
      queueTimeouts: 0,
      abortedWhileQueued: 0,
    };
    this.states.set(key, state);
    return state;
  }

  private makeLease(state: PerKeyState): AdaptiveLease {
    let released = false;
    return {
      key: state.key,
      release: (latencyMs: number) => {
        if (released) return;
        released = true;
        if (state.inFlight > 0) state.inFlight--;
        state.released++;
        this.recordAndAdjust(state, latencyMs);
        this.drain(state);
      },
    };
  }

  private recordAndAdjust(state: PerKeyState, latencyMs: number): void {
    // Record latency in window (window discards invalid values)
    state.window.record(latencyMs);

    // Update EMA
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      state.ema.update(latencyMs);
    }

    // If window is empty (no valid samples), don't adjust
    const minLat = state.window.min();
    const emaValue = state.ema.value;
    if (minLat === undefined || emaValue === undefined) return;

    // Compute gradient
    const gradient = computeGradient(minLat, emaValue);
    state.lastGradient = gradient;

    // Compute new limit
    const headroom = 1;
    let newLimit = computeNewLimit(
      state.limit,
      gradient,
      headroom,
      this.config.minLimit,
      this.config.maxLimit,
    );

    // Probe logic
    state.probeCount++;
    if (state.probeCount >= this.config.probeInterval) {
      newLimit = Math.min(newLimit + 1, this.config.maxLimit);
      state.probeCount = 0;
    }

    // Emit event if limit changed
    if (newLimit !== state.limit) {
      const previousLimit = state.limit;
      state.limit = newLimit;

      if (this.config.onLimitChange) {
        const event: LimitChangeEvent = {
          key: state.key,
          previousLimit,
          newLimit,
          gradient,
          smoothedLatency: emaValue,
          minLatency: minLat,
          timestamp: Date.now(),
        };
        this.config.onLimitChange(event);
      }
    } else {
      state.limit = newLimit;
    }
  }

  private drain(state: PerKeyState): void {
    while (state.inFlight < state.limit && state.queue.length > 0) {
      const waiter = state.queue.shift()!;
      this.cleanupWaiter(waiter);
      if (waiter.signal.aborted) {
        state.abortedWhileQueued++;
        waiter.reject(abortError());
        continue;
      }
      state.inFlight++;
      state.acquired++;
      waiter.resolve(this.makeLease(state));
    }
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

  private stateToStats(state: PerKeyState): AdaptiveLimiterStats {
    return {
      limit: state.limit,
      inFlight: state.inFlight,
      queueDepth: state.queue.length,
      gradient: state.lastGradient,
      smoothedLatency: state.ema.value,
      minLatency: state.window.min(),
      p50: state.window.percentile(50),
      p99: state.window.percentile(99),
      probeCount: state.probeCount,
      windowSize: state.window.length,
    };
  }
}
