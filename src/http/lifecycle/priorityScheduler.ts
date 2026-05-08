// src/http/lifecycle/priorityScheduler.ts
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { registerHttpEffect } from "../effectRunner";
import { PriorityQueue, clampPriority } from "./priorityQueue";

/**
 * Configuration for the priority scheduler middleware.
 */
export type PriorityConfig = {
  /** Maximum concurrent requests dispatched to the wire client. Default: 32. */
  concurrency?: number;
  /** Queue timeout in ms for priority-queued requests. Default: no timeout. */
  queueTimeoutMs?: number;
  /** Optional lifecycle observer for queue events. */
  onEvent?: (event: { type: "queue-enqueue" | "queue-dispatch"; priority: number }) => void;
};

/**
 * Internal entry representing a queued request waiting for a concurrency slot.
 */
type QueuedRequest = {
  readonly req: HttpRequest;
  readonly env: unknown;
  readonly cb: (exit: Exit<HttpError, HttpWireResponse>) => void;
  readonly signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_CONCURRENCY = 32;

/**
 * Extracts the priority value from a request.
 * Looks at `(req as any).priority` first, then `(req.init as any)?.priority`.
 * Returns default of 5 if not found, clamps to [0, 9].
 */
function extractPriority(req: HttpRequest): number {
  const fromReq = (req as any).priority;
  if (fromReq !== undefined) return clampPriority(fromReq);

  const fromInit = (req.init as any)?.priority;
  if (fromInit !== undefined) return clampPriority(fromInit);

  return 5;
}

function safeEmit(
  onEvent: ((event: { type: "queue-enqueue" | "queue-dispatch"; priority: number }) => void) | undefined,
  event: { type: "queue-enqueue" | "queue-dispatch"; priority: number }
): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* swallow observer errors */
  }
}

/**
 * Creates a priority scheduler middleware that reorders queued requests
 * by priority before dispatching them to the downstream wire client.
 *
 * When the concurrency limit is not reached, requests are dispatched immediately.
 * When at capacity, requests are held in a priority queue (lower numeric priority = higher urgency)
 * and dispatched in priority order as slots become available.
 *
 * Supports:
 * - Priority extraction from request options (default 5, clamped to 0-9)
 * - Queue timeout via `queueTimeoutMs` config (produces PoolTimeout error)
 * - Cancellation: removes from queue on abort signal
 * - Stats tracking via `queueDepth` getter
 *
 * @param config - Optional priority scheduler configuration.
 *   - `concurrency`: Maximum concurrent requests dispatched to the Wire_Client.
 *     Must be a positive integer (>= 1). Default: 32.
 *   - `queueTimeoutMs`: Maximum time in milliseconds a request may wait in the queue
 *     before receiving a PoolTimeout error. Must be a positive integer (>= 1) or undefined
 *     for no timeout. Default: undefined (no timeout).
 * @returns An HttpMiddleware (with an additional `queueDepth()` method) that wraps the
 *   next Wire_Client with priority-based scheduling. Requests carry a priority level
 *   (integer from 0 to 9, where 0 is highest urgency). Default priority is 5.
 *
 * @example
 * ```typescript
 * import { withPriority } from "./priorityScheduler";
 *
 * // Basic usage with default concurrency (32)
 * const priorityMiddleware = withPriority();
 *
 * // Limit concurrency and set queue timeout
 * const scheduler = withPriority({
 *   concurrency: 4,
 *   queueTimeoutMs: 5000,
 * });
 *
 * // Check current queue depth
 * const depth = scheduler.queueDepth();
 * ```
 */
export function withPriority(config?: PriorityConfig): HttpMiddleware & { queueDepth: () => number } {
  const concurrency = resolveConcurrency(config?.concurrency);
  const queueTimeoutMs = resolveQueueTimeout(config?.queueTimeoutMs);
  const onEvent = config?.onEvent;
  const queue = new PriorityQueue<QueuedRequest>();
  let inFlight = 0;

  const queueDepth = (): number => {
    return queue.activeSize;
  };

  const middleware: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      const priority = extractPriority(req);

      return {
        _tag: "Async",
        register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          // If we have capacity, dispatch immediately
          if (inFlight < concurrency) {
            return dispatchRequest(next, req, env, cb);
          }

          // Otherwise, enqueue in the priority queue
          const queued: QueuedRequest = { req, env, cb, signal: getSignal(req) };
          const entry = queue.enqueue(queued, priority);
          safeEmit(onEvent, { type: "queue-enqueue", priority });

          // Set up queue timeout if configured
          if (queueTimeoutMs !== undefined) {
            queued.timer = setTimeout(() => {
              entry.cancelled = true;
              queued.timer = undefined;
              cb({
                _tag: "Failure",
                cause: Cause.fail({
                  _tag: "PoolTimeout",
                  key: "priority",
                  timeoutMs: queueTimeoutMs,
                  message: `Priority queue did not dispatch within ${queueTimeoutMs}ms`,
                } as HttpError),
              });
            }, queueTimeoutMs);
          }

          // Set up abort signal listener for cancellation
          const signal = queued.signal;
          let abortHandler: (() => void) | undefined;

          if (signal && !signal.aborted) {
            abortHandler = () => {
              // Mark entry as cancelled in the priority queue (lazy removal)
              entry.cancelled = true;
              // Clear timeout if set
              if (queued.timer !== undefined) {
                clearTimeout(queued.timer);
                queued.timer = undefined;
              }
              cb({ _tag: "Failure", cause: Cause.fail({ _tag: "Abort" } satisfies HttpError) });
            };
            signal.addEventListener("abort", abortHandler, { once: true });
          } else if (signal?.aborted) {
            // Already aborted — cancel immediately
            entry.cancelled = true;
            cb({ _tag: "Failure", cause: Cause.fail({ _tag: "Abort" } satisfies HttpError) });
            return;
          }

          // Return cancellation function
          return () => {
            // Mark entry as cancelled
            entry.cancelled = true;
            // Clear timeout
            if (queued.timer !== undefined) {
              clearTimeout(queued.timer);
              queued.timer = undefined;
            }
            // Remove abort listener
            if (abortHandler && signal) {
              signal.removeEventListener("abort", abortHandler);
            }
            // Signal interrupt
            cb({ _tag: "Failure", cause: Cause.interrupt() });
          };
        },
      };
    };

    /**
     * Dispatches a request immediately, tracking inFlight count.
     * When the request completes, drains the next item from the priority queue.
     */
    function dispatchRequest(
      downstream: HttpClientFn,
      req: HttpRequest,
      env: unknown,
      cb: (exit: Exit<HttpError, HttpWireResponse>) => void,
    ): void | (() => void) {
      inFlight++;
      safeEmit(onEvent, { type: "queue-dispatch", priority: extractPriority(req) });

      const innerEffect = downstream(req);
      let completed = false;

      const onComplete = (exit: Exit<HttpError, HttpWireResponse>) => {
        if (completed) return;
        completed = true;
        inFlight--;
        cb(exit);
        // Drain the next queued request
        drainNext(downstream);
      };

      const innerCancel = registerHttpEffect(innerEffect, env, onComplete);

      // Return cancellation function for the dispatched request
      return () => {
        innerCancel();
      };
    }

    /**
     * Drains the next non-cancelled entry from the priority queue and dispatches it.
     */
    function drainNext(downstream: HttpClientFn): void {
      while (inFlight < concurrency) {
        const entry = queue.dequeue();
        if (!entry) break;

        // Entry was already cancelled (lazy removal)
        if (entry.cancelled) continue;

        const queued = entry.value;

        // Clear the queue timeout timer
        if (queued.timer !== undefined) {
          clearTimeout(queued.timer);
          queued.timer = undefined;
        }

        // Check if the signal was aborted while queued
        if (queued.signal?.aborted) {
          queued.cb({ _tag: "Failure", cause: Cause.fail({ _tag: "Abort" } satisfies HttpError) });
          continue;
        }

        // Dispatch the queued request
        dispatchRequest(downstream, queued.req, queued.env, queued.cb);
      }
    }
  };

  // Attach queueDepth as a property on the middleware function
  return Object.assign(middleware, { queueDepth });
}

/**
 * Resolves the concurrency config value to a positive integer.
 */
function resolveConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

/**
 * Resolves the queue timeout config value.
 */
function resolveQueueTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

/**
 * Extracts the AbortSignal from a request's init options.
 */
function getSignal(req: HttpRequest): AbortSignal | undefined {
  return (req.init as any)?.signal as AbortSignal | undefined;
}
