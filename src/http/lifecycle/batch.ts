// src/http/lifecycle/batch.ts
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { registerHttpEffect } from "../effectRunner";

/**
 * Developer-provided function that defines how to combine multiple requests
 * into one and split the response back.
 *
 * @typeParam K - The item type extracted from individual requests, ensuring
 *   type consistency between coalesce and split.
 */
export type BatchFunction<K> = {
  /**
   * Combines multiple HttpRequest objects into a single batched HttpRequest.
   * The items array corresponds 1:1 with the requests array.
   */
  coalesce: (requests: readonly HttpRequest[]) => HttpRequest;

  /**
   * Splits the batched response back into individual responses.
   * Must return an array of the same length as the original requests array.
   */
  split: (response: HttpWireResponse, requests: readonly HttpRequest[]) => HttpWireResponse[];
};

/**
 * Configuration for the Batch_Middleware.
 *
 * @typeParam K - The item type linking coalesce and split operations.
 */
export type BatchConfig<K = unknown> = {
  /** The batch function defining coalesce/split logic. Required. */
  batch: BatchFunction<K>;

  /**
   * Time window in milliseconds to collect requests before dispatching.
   * Valid range: [1, 5000]. Required.
   */
  windowMs: number;

  /**
   * Maximum number of requests in a single batch.
   * When reached, the batch dispatches immediately.
   * Valid range: [2, 10000]. Required.
   */
  maxBatchSize: number;

  /**
   * Computes the Batch_Key from a request.
   * Requests with the same key are batched together.
   * Return empty string to bypass batching for a request.
   * Throwing bypasses batching for that request.
   */
  batchKey: (req: HttpRequest) => string;
};

// --- Internal types ---

/**
 * A pending caller waiting for their individual response from a batch.
 */
export type BatchWaiter = {
  readonly request: HttpRequest;
  resolve: (res: HttpWireResponse) => void;
  reject: (err: HttpError) => void;
};

/**
 * A group of requests sharing the same Batch_Key, collected during a window.
 */
export type BatchGroup = {
  readonly key: string;
  readonly controller: AbortController;
  readonly waiters: BatchWaiter[];
  timer: ReturnType<typeof setTimeout> | null;
  dispatched: boolean;
};


// --- Event callback type ---

/**
 * Optional observer callback for batch lifecycle events.
 */
export type BatchEventCallback = (event: {
  type: "batch-hit" | "batch-dispatch";
  batchKey: string;
  batchSize?: number;
}) => void;

// --- Helpers ---

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function safeEmitBatch(
  onEvent: BatchEventCallback | undefined,
  event: { type: "batch-hit" | "batch-dispatch"; batchKey: string; batchSize?: number },
): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* swallow observer errors */
  }
}

function causeDefectMessage(cause: Cause<unknown>): string {
  const defect = Cause.firstDefect(cause);
  if (defect._tag === "Some") return String(defect.value);
  return Cause.pretty(cause, { singleLine: true });
}

// --- Middleware Factory ---

/**
 * Creates a Batch_Middleware that collects requests by Batch_Key during
 * a time window and dispatches them as a single batched request.
 *
 * @typeParam K - Inferred from the provided BatchFunction.
 * @param config - Batch configuration.
 * @param onEvent - Optional lifecycle event observer.
 * @returns An HttpMiddleware conforming to (next: HttpClientFn) => HttpClientFn.
 */
export function withBatch<K>(config: BatchConfig<K>, onEvent?: BatchEventCallback): HttpMiddleware {
  // 2.11: Clamp windowMs to [1, 5000] and maxBatchSize to [2, 10000]
  const windowMs = clamp(config.windowMs, 1, 5000);
  const maxBatchSize = clamp(config.maxBatchSize, 2, 10000);
  const { batch, batchKey } = config;

  const groups = new Map<string, BatchGroup>();

  return (next: HttpClientFn): HttpClientFn => {
    /**
     * Dispatches a batch group: calls coalesce, sends to next, calls split,
     * and distributes responses to all waiters.
     */
    function dispatch(group: BatchGroup): void {
      // Mark as dispatched and clear timer
      group.dispatched = true;
      if (group.timer !== null) {
        clearTimeout(group.timer);
        group.timer = null;
      }

      // Remove from active groups map
      groups.delete(group.key);

      const requests = group.waiters.map((w) => w.request);
      const waiterCount = group.waiters.length;

      // 2.9: Wrap coalesce throws as FetchError
      let coalescedReq: HttpRequest;
      try {
        coalescedReq = batch.coalesce(requests);
      } catch (err) {
        const error: HttpError = { _tag: "FetchError", message: String(err) };
        rejectAllWaiters(group, error);
        return;
      }

      // Attach the group's AbortController signal to the coalesced request
      coalescedReq = {
        ...coalescedReq,
        init: {
          ...(coalescedReq.init ?? {}),
          signal: group.controller.signal,
        } as any,
      };

      // Emit batch-dispatch event
      safeEmitBatch(onEvent, { type: "batch-dispatch", batchKey: group.key, batchSize: waiterCount });

      // Execute the batched request through the next middleware
      const innerEffect = next(coalescedReq);

      registerHttpEffect(innerEffect, undefined, (exit: Exit<HttpError, HttpWireResponse>) => {
        if (exit._tag === "Success") {
          // 2.5: Call split and distribute responses
          let responses: HttpWireResponse[];
          try {
            responses = batch.split(exit.value, requests);
          } catch (err) {
            // 2.9: Wrap split throws as FetchError
            const error: HttpError = { _tag: "FetchError", message: String(err) };
            rejectAllWaiters(group, error);
            return;
          }

          // 2.8: Validate split length
          if (responses.length !== waiterCount) {
            const error: HttpError = {
              _tag: "BatchSplitError",
              expected: waiterCount,
              actual: responses.length,
              message: `split returned ${responses.length} responses but expected ${waiterCount}`,
            };
            rejectAllWaiters(group, error);
            return;
          }

          // Distribute responses to each waiter by index
          const waiters = group.waiters.slice();
          for (let i = 0; i < waiters.length; i++) {
            waiters[i].resolve(responses[i]);
          }
          return;
        }

        // 2.10: Batch failure propagation - same error to all callers
        const failure = Cause.firstFailure(exit.cause);
        if (failure._tag === "Some") {
          rejectAllWaiters(group, failure.value);
          return;
        }

        if (Cause.isInterruptedOnly(exit.cause)) {
          rejectAllWaiters(group, { _tag: "Abort" });
          return;
        }

        // Die/defect case
        const err: HttpError = { _tag: "FetchError", message: causeDefectMessage(exit.cause) };
        rejectAllWaiters(group, err);
      });
    }

    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      // 2.2: Compute batchKey with empty-string bypass and try/catch
      let key: string;
      try {
        key = batchKey(req);
      } catch {
        // Throwing batchKey function → bypass batching
        return next(req);
      }

      // Empty string → bypass batching
      if (!key) {
        return next(req);
      }

      // Return a lazy Async effect
      return {
        _tag: "Async",
        register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          let callerDone = false;
          const finishCaller = (exit: Exit<HttpError, HttpWireResponse>) => {
            if (callerDone) return;
            callerDone = true;
            cb(exit);
          };

          const waiter: BatchWaiter = {
            request: req,
            resolve: (res: HttpWireResponse) => {
              finishCaller({ _tag: "Success", value: res });
            },
            reject: (err: HttpError) => {
              finishCaller({ _tag: "Failure", cause: Cause.fail(err) });
            },
          };

          const existing = groups.get(key);

          if (existing && !existing.dispatched) {
            // 2.4: Join existing group without resetting timer
            existing.waiters.push(waiter);

            // Emit batch-hit event
            safeEmitBatch(onEvent, { type: "batch-hit", batchKey: key });

            // 2.6: Check maxBatchSize immediate dispatch trigger
            if (existing.waiters.length >= maxBatchSize) {
              dispatch(existing);
            }

            // Return cancellation function
            return () => {
              if (callerDone) return;

              // Remove this waiter from the group
              const idx = existing.waiters.indexOf(waiter);
              if (idx >= 0) {
                existing.waiters.splice(idx, 1);
              }

              // If no more waiters and not dispatched, cancel the group
              if (existing.waiters.length === 0 && !existing.dispatched) {
                if (existing.timer !== null) {
                  clearTimeout(existing.timer);
                  existing.timer = null;
                }
                groups.delete(key);
              }

              // If no more waiters and dispatched, abort underlying
              if (existing.waiters.length === 0 && existing.dispatched) {
                existing.controller.abort();
              }

              // Signal interrupt to this caller
              finishCaller({ _tag: "Failure", cause: Cause.interrupt() });
            };
          }

          // 2.3: Create new Batch_Group with timer start on first request
          const controller = new AbortController();
          const group: BatchGroup = {
            key,
            controller,
            waiters: [waiter],
            timer: null,
            dispatched: false,
          };

          // Start the timer
          group.timer = setTimeout(() => {
            if (!group.dispatched && group.waiters.length > 0) {
              dispatch(group);
            }
          }, windowMs);

          groups.set(key, group);

          // 2.7: After maxBatchSize dispatch, a new request for the same key
          // will not find the old group (it's deleted in dispatch), so it creates
          // a fresh group here — this is the natural behavior.

          // Return cancellation function for the initiator
          return () => {
            if (callerDone) return;

            // Remove this waiter from the group
            const idx = group.waiters.indexOf(waiter);
            if (idx >= 0) {
              group.waiters.splice(idx, 1);
            }

            // If no more waiters and not dispatched, cancel the group
            if (group.waiters.length === 0 && !group.dispatched) {
              if (group.timer !== null) {
                clearTimeout(group.timer);
                group.timer = null;
              }
              groups.delete(key);
            }

            // If no more waiters and dispatched, abort underlying
            if (group.waiters.length === 0 && group.dispatched) {
              group.controller.abort();
            }

            // Signal interrupt to this caller
            finishCaller({ _tag: "Failure", cause: Cause.interrupt() });
          };
        },
      };
    };
  };
}

/**
 * Rejects all waiters in a group with the same error.
 */
function rejectAllWaiters(group: BatchGroup, err: HttpError): void {
  const waiters = group.waiters.slice();
  for (const w of waiters) {
    w.reject(err);
  }
}
