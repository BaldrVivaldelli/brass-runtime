// src/core/runtime/shutdown.ts
// Graceful shutdown utilities for brass-runtime.
//
// Provides controlled shutdown that waits for in-flight fibers,
// drains queues, and executes finalizers with a timeout.

import { Async, async, asyncFlatMap, unit } from "../types/asyncEffect";
import type { Runtime } from "./runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShutdownConfig = {
  /** Max time to wait for in-flight work to complete. Default: 30000ms */
  readonly timeoutMs?: number;
  /** Called when shutdown starts. */
  readonly onStart?: () => void;
  /** Called when shutdown completes. */
  readonly onComplete?: (stats: ShutdownStats) => void;
  /** Called if shutdown times out. */
  readonly onTimeout?: (stats: ShutdownStats) => void;
};

export type ShutdownStats = {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Performs a graceful shutdown of the runtime.
 *
 * 1. Signals the scheduler to stop accepting new work
 * 2. Waits for in-flight fibers to complete (up to timeoutMs)
 * 3. Calls the runtime's shutdown hook
 * 4. Reports stats
 *
 * ```ts
 * await gracefulShutdown(runtime, {
 *   timeoutMs: 5000,
 *   onStart: () => console.log("Shutting down..."),
 *   onComplete: (stats) => console.log(`Done in ${stats.elapsedMs}ms`),
 * });
 * ```
 */
export async function gracefulShutdown<R>(
  runtime: Runtime<R>,
  config: ShutdownConfig = {}
): Promise<ShutdownStats> {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  config.onStart?.();

  let timedOut = false;

  // Race: wait for runtime shutdown vs timeout
  const shutdownPromise = (async () => {
    try {
      await runtime.shutdown();
    } catch {
      // best-effort
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([shutdownPromise, timeoutPromise]);

  const completedAt = Date.now();
  const stats: ShutdownStats = {
    startedAt,
    completedAt,
    elapsedMs: completedAt - startedAt,
    timedOut,
  };

  if (timedOut) {
    config.onTimeout?.(stats);
  } else {
    config.onComplete?.(stats);
  }

  return stats;
}

/**
 * Registers process signal handlers for graceful shutdown.
 * Handles SIGTERM and SIGINT (Ctrl+C).
 *
 * ```ts
 * registerShutdownHooks(runtime, {
 *   timeoutMs: 10000,
 *   onComplete: () => process.exit(0),
 *   onTimeout: () => process.exit(1),
 * });
 * ```
 */
export function registerShutdownHooks<R>(
  runtime: Runtime<R>,
  config: ShutdownConfig = {}
): () => void {
  let shuttingDown = false;

  const handler = (signal: string) => {
    if (shuttingDown) {
      // Force exit on second signal
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[brass-runtime] Received ${signal}, shutting down gracefully...`);

    gracefulShutdown(runtime, {
      ...config,
      onComplete: (stats) => {
        config.onComplete?.(stats);
        if (!config.onComplete) {
          console.log(`[brass-runtime] Shutdown complete (${stats.elapsedMs}ms)`);
          process.exit(0);
        }
      },
      onTimeout: (stats) => {
        config.onTimeout?.(stats);
        if (!config.onTimeout) {
          console.log(`[brass-runtime] Shutdown timed out after ${stats.elapsedMs}ms, forcing exit`);
          process.exit(1);
        }
      },
    });
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));

  // Return cleanup function
  return () => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  };
}
