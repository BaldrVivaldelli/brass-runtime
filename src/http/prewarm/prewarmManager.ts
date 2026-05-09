// src/http/prewarm/prewarmManager.ts — PrewarmManager factory and implementation.

import type { Async } from "../../core/types/asyncEffect";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type {
  PrewarmConfig,
  PrewarmEvent,
  PrewarmResult,
  PrewarmStatusSnapshot,
} from "./types";
import { validateOrigin } from "./validation";
import { detectPlatform, validateFetchAvailable } from "./platform";
import { executeProbe } from "./probe";
import { makeConnectionStateMap, type ConnectionStateMap } from "./connectionState";
import { makeBudgetSemaphore, type BudgetSemaphore } from "./budgetSemaphore";

/**
 * The PrewarmManager interface for managing connection pre-warming.
 */
export type PrewarmManager = {
  /** Warm a single origin. Skips if already warm. */
  warm: (origin: string) => Promise<PrewarmResult>;
  /** Warm all configured origins. Skips already-warm origins. */
  warmAll: () => Promise<PrewarmResult[]>;
  /** Check if an origin has an active warm connection. */
  isWarm: (origin: string) => boolean;
  /** Cancel in-flight probe for a specific origin. */
  cancel: (origin: string) => void;
  /** Cancel all in-flight and queued probes. */
  cancelAll: () => void;
  /** Get a snapshot of all managed origins and their states. */
  status: () => PrewarmStatusSnapshot;
  /** Dispose the manager: cancel all, stop timers, release resources. */
  dispose: () => void;
};

/** Default configuration values. */
const DEFAULTS = {
  keepAliveDurationMs: 55_000,
  budget: 4,
  probeTimeoutMs: 5_000,
  autoRefresh: false,
  useClientPool: false,
} as const;

/**
 * Creates a PrewarmManager that proactively establishes TCP+TLS connections
 * to known origins using lightweight HEAD probe requests.
 *
 * @param config - Configuration for the prewarm manager.
 * @returns A PrewarmManager instance.
 * @throws Error if fetch/AbortController is unavailable or origins are invalid.
 */
export function makePrewarmManager(config: PrewarmConfig): PrewarmManager {
  // Validate platform prerequisites
  validateFetchAvailable();

  // Resolve configuration with defaults
  const keepAliveDurationMs = config.keepAliveDurationMs ?? DEFAULTS.keepAliveDurationMs;
  const budget = config.budget ?? DEFAULTS.budget;
  const probeTimeoutMs = config.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs;
  const autoRefresh = config.autoRefresh ?? DEFAULTS.autoRefresh;
  const useClientPool = config.useClientPool ?? DEFAULTS.useClientPool;
  const onEvent = config.onEvent;
  const client = config.client;

  // Validate and normalize all origins
  const origins = config.origins.map((o) => validateOrigin(o));

  // Detect platform once at construction
  const platform = detectPlatform();

  // Create internal state tracking
  const stateMap: ConnectionStateMap = makeConnectionStateMap(origins, keepAliveDurationMs);
  const semaphore: BudgetSemaphore = makeBudgetSemaphore(budget);

  // Per-origin abort controllers for in-flight probes
  const abortControllers = new Map<string, AbortController>();

  // Per-origin auto-refresh timers
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Disposed flag
  let disposed = false;

  /** Emit a prewarm event to the observer. */
  function emit(event: PrewarmEvent): void {
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        // Observer errors are silently ignored
      }
    }
  }

  /** Schedule an auto-refresh timer for an origin after a successful probe. */
  function scheduleAutoRefresh(origin: string): void {
    if (!autoRefresh || disposed) return;

    // Clear any existing timer for this origin
    clearRefreshTimer(origin);

    const delay = Math.floor(0.8 * keepAliveDurationMs);
    const timer = setTimeout(() => {
      refreshTimers.delete(origin);
      if (disposed) return;

      // Check if the origin is still warm — if so, re-probe
      if (stateMap.isWarm(origin)) {
        // Mark expired and emit event before re-probing
        stateMap.markExpired(origin);
        emit({
          type: "connection-expired",
          origin,
          timestamp: Date.now(),
        });
      }
      // Trigger re-probe
      warm(origin).catch(() => {
        // Swallow errors from auto-refresh probes
      });
    }, delay);

    // In Node.js, unref the timer so it doesn't keep the process alive
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    refreshTimers.set(origin, timer);
  }

  /** Clear a refresh timer for an origin. */
  function clearRefreshTimer(origin: string): void {
    const timer = refreshTimers.get(origin);
    if (timer !== undefined) {
      clearTimeout(timer);
      refreshTimers.delete(origin);
    }
  }

  /** Clear all refresh timers. */
  function clearAllRefreshTimers(): void {
    for (const [, timer] of refreshTimers) {
      clearTimeout(timer);
    }
    refreshTimers.clear();
  }

  /**
   * Warm a single origin. Skips if already warm.
   * Returns a PrewarmResult indicating the outcome.
   */
  async function warm(origin: string): Promise<PrewarmResult> {
    if (disposed) {
      return { origin, status: "cancelled", durationMs: 0 };
    }

    // Check if already warm — skip probe
    if (stateMap.isWarm(origin)) {
      return { origin, status: "already-warm", durationMs: 0 };
    }

    // Acquire semaphore slot
    const { release } = await semaphore.acquire();

    // Re-check after acquiring (may have been cancelled/disposed while waiting)
    if (disposed) {
      release();
      return { origin, status: "cancelled", durationMs: 0 };
    }

    // Create abort controller for this probe
    const controller = new AbortController();
    abortControllers.set(origin, controller);

    // Mark as probing
    stateMap.markProbing(origin);

    try {
      const probeOptions = {
        timeoutMs: probeTimeoutMs,
        signal: controller.signal,
        platform,
        client: useClientPool ? client : undefined,
      };

      const outcome = await executeProbe(origin, probeOptions);

      // Check if cancelled during probe
      if (controller.signal.aborted) {
        stateMap.markIdle(origin);
        emit({
          type: "connection-cancelled",
          origin,
          timestamp: Date.now(),
        });
        return { origin, status: "cancelled", durationMs: outcome.durationMs };
      }

      if (outcome.ok) {
        // Mark warm and emit event
        stateMap.markWarm(origin);
        emit({
          type: "connection-warmed",
          origin,
          timestamp: Date.now(),
          durationMs: outcome.durationMs,
        });

        // Schedule auto-refresh if enabled
        scheduleAutoRefresh(origin);

        return { origin, status: "warmed", durationMs: outcome.durationMs };
      } else {
        // Probe failed
        stateMap.markIdle(origin);
        emit({
          type: "connection-failed",
          origin,
          timestamp: Date.now(),
          error: outcome.error,
        });
        return { origin, status: "failed", durationMs: outcome.durationMs, error: outcome.error };
      }
    } catch (err: unknown) {
      // Unexpected error — treat as failure
      stateMap.markIdle(origin);
      const error = err instanceof Error ? err.message : String(err);
      emit({
        type: "connection-failed",
        origin,
        timestamp: Date.now(),
        error,
      });
      return { origin, status: "failed", durationMs: 0, error };
    } finally {
      abortControllers.delete(origin);
      release();
    }
  }

  /**
   * Warm all configured origins. Returns results for each origin.
   */
  async function warmAll(): Promise<PrewarmResult[]> {
    const results = await Promise.all(origins.map((o) => warm(o)));
    return results;
  }

  /**
   * Cancel an in-flight probe for a specific origin.
   */
  function cancel(origin: string): void {
    const controller = abortControllers.get(origin);
    if (controller) {
      controller.abort();
    }
    clearRefreshTimer(origin);
  }

  /**
   * Cancel all in-flight probes and clear queued work.
   */
  function cancelAll(): void {
    for (const [, controller] of abortControllers) {
      controller.abort();
    }
    clearAllRefreshTimers();
  }

  /**
   * Check if an origin has an active warm connection.
   */
  function isWarm(origin: string): boolean {
    if (disposed) return false;
    return stateMap.isWarm(origin);
  }

  /**
   * Get a snapshot of all managed origins and their states.
   */
  function status(): PrewarmStatusSnapshot {
    return stateMap.snapshot();
  }

  /**
   * Dispose the manager: cancel all operations, stop timers, release resources.
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAll();
    // Reset all origins to idle
    for (const origin of origins) {
      stateMap.markIdle(origin);
    }
  }

  return {
    warm,
    warmAll,
    isWarm,
    cancel,
    cancelAll,
    status,
    dispose,
  };
}
