// src/http/lifecycle/dedup.ts
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { registerHttpEffect } from "../effectRunner";
import { computeDedupKey, SAFE_METHODS } from "./dedupKey";

/**
 * Configuration for the deduplication middleware.
 */
export type DedupConfig = {
  /** Custom key function. When provided, overrides default key computation. */
  dedupKey?: (req: HttpRequest) => string;
  /** Optional lifecycle observer for dedup hits/misses. */
  onEvent?: (event: { type: "dedup-hit" | "dedup-miss" | "dedup-active"; cacheKey?: string; active?: number }) => void;
};

function safeEmit(
  onEvent: ((event: { type: "dedup-hit" | "dedup-miss" | "dedup-active"; cacheKey?: string; active?: number }) => void) | undefined,
  event: { type: "dedup-hit" | "dedup-miss" | "dedup-active"; cacheKey?: string; active?: number }
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

/**
 * Internal entry tracking an in-flight deduplicated request.
 */
type DedupEntry = {
  readonly key: string;
  readonly controller: AbortController;
  refCount: number;
  waiters: Array<{
    resolve: (res: HttpWireResponse) => void;
    reject: (err: HttpError) => void;
  }>;
};

/**
 * Creates a deduplication middleware that collapses identical in-flight requests
 * into a single network call.
 *
 * For safe HTTP methods (GET, HEAD, OPTIONS), concurrent requests with the same
 * dedup key share a single underlying network call. All callers receive the same
 * response or error.
 *
 * Non-safe methods (POST, PUT, PATCH, DELETE) pass through without deduplication.
 *
 * Supports ref-counted cancellation: when a caller cancels, the refCount is decremented.
 * When refCount reaches 0, the underlying request is aborted via AbortController.
 *
 * @param config - Optional dedup configuration. Provide a `dedupKey` function to override
 *   the default Cache_Key computation. Return an empty string from `dedupKey` to bypass
 *   deduplication for a specific request.
 * @returns An HttpMiddleware that wraps the next Wire_Client with deduplication logic.
 *   Concurrent safe-method requests sharing the same key resolve to a single network call.
 *
 * @example
 * ```typescript
 * import { withDedup } from "./dedup";
 *
 * // Basic usage with default key computation
 * const dedupMiddleware = withDedup();
 *
 * // With custom key function
 * const customDedup = withDedup({
 *   dedupKey: (req) => `${req.method}:${req.url}`,
 * });
 * ```
 */
export function withDedup(config?: DedupConfig): HttpMiddleware {
  const inFlight = new Map<string, DedupEntry>();
  const customKeyFn = config?.dedupKey;
  const onEvent = config?.onEvent;

  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      // Non-safe methods bypass dedup entirely
      if (!SAFE_METHODS.has(req.method.toUpperCase())) {
        return next(req);
      }

      // Compute the dedup key
      let key: string;
      if (customKeyFn) {
        try {
          key = customKeyFn(req);
        } catch {
          // Custom key function threw — bypass dedup
          return next(req);
        }
        // Empty string means bypass dedup
        if (!key) {
          return next(req);
        }
      } else {
        // Use default key computation with empty baseUrl (URL resolution happens upstream)
        key = computeDedupKey(req, "");
      }

      // Return a lazy Async effect
      return {
        _tag: "Async",
        register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          const existing = inFlight.get(key);
          let callerDone = false;
          const finishCaller = (exit: Exit<HttpError, HttpWireResponse>) => {
            if (callerDone) return;
            callerDone = true;
            cb(exit);
          };

          if (existing) {
            safeEmit(onEvent, { type: "dedup-hit", cacheKey: key });
            // Attach as a waiter to the existing in-flight request
            existing.refCount++;

            const waiter = {
              resolve: (res: HttpWireResponse) => {
                finishCaller({ _tag: "Success", value: res });
              },
              reject: (err: HttpError) => {
                finishCaller({ _tag: "Failure", cause: Cause.fail(err) });
              },
            };

            existing.waiters.push(waiter);

            // Return cancellation function (ref-counted)
            return () => {
              if (callerDone) return;
              existing.refCount--;

              // Remove this waiter from the list
              const idx = existing.waiters.indexOf(waiter);
              if (idx >= 0) {
                existing.waiters.splice(idx, 1);
              }

              // If no more callers, abort the underlying request
              if (existing.refCount <= 0) {
                inFlight.delete(key);
                safeEmit(onEvent, { type: "dedup-active", active: inFlight.size });
                existing.controller.abort();
              }

              // Signal interrupt to this caller
              finishCaller({ _tag: "Failure", cause: Cause.interrupt() });
            };
          }

          // Start a new in-flight request
          safeEmit(onEvent, { type: "dedup-miss", cacheKey: key });
          const controller = new AbortController();
          const entry: DedupEntry = {
            key,
            controller,
            refCount: 1,
            waiters: [],
          };

          inFlight.set(key, entry);
          safeEmit(onEvent, { type: "dedup-active", active: inFlight.size });

          // Build the request with the dedup controller's signal
          const dedupReq: HttpRequest = {
            ...req,
            init: {
              ...(req.init ?? {}),
              signal: controller.signal,
            } as any,
          };

          // Execute the underlying request
          const innerEffect = next(dedupReq);

          const innerCancel = registerHttpEffect(innerEffect, _env, (exit) => {
            inFlight.delete(key);
            safeEmit(onEvent, { type: "dedup-active", active: inFlight.size });

            if (exit._tag === "Success") {
              resolveAll(entry, exit.value);
              finishCaller(exit);
              return;
            }

            if (Cause.isInterruptedOnly(exit.cause)) {
              rejectAll(entry, { _tag: "Abort" });
              finishCaller({ _tag: "Failure", cause: Cause.interrupt() });
              return;
            }

            const failure = Cause.firstFailure(exit.cause);
            if (failure._tag === "Some") {
              rejectAll(entry, failure.value);
              finishCaller(exit);
              return;
            }

            const err: HttpError = { _tag: "FetchError", message: causeDefectMessage(exit.cause) };
            rejectAll(entry, err);
            finishCaller({ _tag: "Failure", cause: Cause.fail(err) });
          });

          // Return cancellation function for the initiator
          return () => {
            if (callerDone) return;
            entry.refCount--;

            if (entry.refCount <= 0) {
              // All callers cancelled — abort the underlying request
              inFlight.delete(key);
              safeEmit(onEvent, { type: "dedup-active", active: inFlight.size });
              controller.abort();
              if (innerCancel) {
                innerCancel();
              }
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
 * Resolves all waiters with a successful response.
 */
function resolveAll(entry: DedupEntry, res: HttpWireResponse): void {
  const waiters = entry.waiters.slice();
  for (const w of waiters) {
    w.resolve(res);
  }
}

/**
 * Rejects all waiters with an error.
 */
function rejectAll(entry: DedupEntry, err: HttpError): void {
  const waiters = entry.waiters.slice();
  for (const w of waiters) {
    w.reject(err);
  }
}
