// src/http/lifecycle/dedup.ts
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { computeDedupKey, SAFE_METHODS } from "./dedupKey";

/**
 * Configuration for the deduplication middleware.
 */
export type DedupConfig = {
  /** Custom key function. When provided, overrides default key computation. */
  dedupKey?: (req: HttpRequest) => string;
};

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

          if (existing) {
            // Attach as a waiter to the existing in-flight request
            existing.refCount++;

            const waiter = {
              resolve: (res: HttpWireResponse) => {
                cb({ _tag: "Success", value: res });
              },
              reject: (err: HttpError) => {
                cb({ _tag: "Failure", cause: Cause.fail(err) });
              },
            };

            existing.waiters.push(waiter);

            // Return cancellation function (ref-counted)
            return () => {
              existing.refCount--;

              // Remove this waiter from the list
              const idx = existing.waiters.indexOf(waiter);
              if (idx >= 0) {
                existing.waiters.splice(idx, 1);
              }

              // If no more callers, abort the underlying request
              if (existing.refCount <= 0) {
                inFlight.delete(key);
                existing.controller.abort();
              }

              // Signal interrupt to this caller
              cb({ _tag: "Failure", cause: Cause.interrupt() });
            };
          }

          // Start a new in-flight request
          const controller = new AbortController();
          const entry: DedupEntry = {
            key,
            controller,
            refCount: 1,
            waiters: [],
          };

          inFlight.set(key, entry);

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

          // Run the inner effect
          let innerCancel: (() => void) | undefined;

          const innerRegister = innerEffect._tag === "Async" ? innerEffect.register : undefined;

          if (innerEffect._tag === "Succeed") {
            // Immediate success
            resolveAll(entry, innerEffect.value);
            cb({ _tag: "Success", value: innerEffect.value });
          } else if (innerEffect._tag === "Fail") {
            // Immediate failure
            rejectAll(entry, innerEffect.error);
            cb({ _tag: "Failure", cause: Cause.fail(innerEffect.error) });
          } else if (innerRegister) {
            // Async effect — register it
            const cancelFn = innerRegister(_env, (exit: Exit<HttpError, HttpWireResponse>) => {
              inFlight.delete(key);

              if (exit._tag === "Success") {
                // Resolve all waiters with the response
                const waiters = entry.waiters.slice();
                for (const w of waiters) {
                  w.resolve(exit.value);
                }
                cb(exit);
              } else {
                // Failure — determine if it's an interrupt or an error
                if (exit.cause._tag === "Interrupt") {
                  // Only propagate interrupt if all callers cancelled
                  // (this happens when refCount reached 0 and we aborted)
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject({ _tag: "Abort" });
                  }
                  cb({ _tag: "Failure", cause: Cause.interrupt() });
                } else if (exit.cause._tag === "Fail") {
                  // Propagate the same error to all waiters
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject(exit.cause.error);
                  }
                  cb(exit);
                } else {
                  // Die — treat as FetchError
                  const err: HttpError = { _tag: "FetchError", message: String((exit.cause as any).defect ?? "unknown") };
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject(err);
                  }
                  cb({ _tag: "Failure", cause: Cause.fail(err) });
                }
              }
            });

            if (typeof cancelFn === "function") {
              innerCancel = cancelFn;
            }
          } else {
            // FlatMap or Fold — we need to run through the effect system
            // For complex effects, wrap in a promise-based approach
            runEffect(innerEffect, _env, (exit) => {
              inFlight.delete(key);

              if (exit._tag === "Success") {
                const waiters = entry.waiters.slice();
                for (const w of waiters) {
                  w.resolve(exit.value);
                }
                cb(exit);
              } else {
                if (exit.cause._tag === "Interrupt") {
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject({ _tag: "Abort" });
                  }
                  cb({ _tag: "Failure", cause: Cause.interrupt() });
                } else if (exit.cause._tag === "Fail") {
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject(exit.cause.error);
                  }
                  cb(exit);
                } else {
                  const err: HttpError = { _tag: "FetchError", message: String((exit.cause as any).defect ?? "unknown") };
                  const waiters = entry.waiters.slice();
                  for (const w of waiters) {
                    w.reject(err);
                  }
                  cb({ _tag: "Failure", cause: Cause.fail(err) });
                }
              }
            });
          }

          // Return cancellation function for the initiator
          return () => {
            entry.refCount--;

            if (entry.refCount <= 0) {
              // All callers cancelled — abort the underlying request
              inFlight.delete(key);
              controller.abort();
              if (innerCancel) {
                innerCancel();
              }
            }

            // Signal interrupt to this caller
            cb({ _tag: "Failure", cause: Cause.interrupt() });
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

/**
 * Minimal effect interpreter for running complex (FlatMap/Fold) effects.
 * This handles the case where the inner effect is not a simple Async or Succeed/Fail.
 */
function runEffect<E, A>(
  effect: Async<unknown, E, A>,
  env: unknown,
  cb: (exit: Exit<E, A>) => void
): void {
  switch (effect._tag) {
    case "Succeed":
      cb({ _tag: "Success", value: effect.value });
      return;
    case "Fail":
      cb({ _tag: "Failure", cause: Cause.fail(effect.error) });
      return;
    case "Sync":
      try {
        const value = effect.thunk(env);
        cb({ _tag: "Success", value });
      } catch (e) {
        cb({ _tag: "Failure", cause: Cause.die(e) as any });
      }
      return;
    case "Async":
      effect.register(env, cb);
      return;
    case "FlatMap":
      runEffect(effect.first, env, (exit) => {
        if (exit._tag === "Failure") {
          cb(exit as any);
          return;
        }
        try {
          const next = effect.andThen(exit.value);
          runEffect(next, env, cb);
        } catch (e) {
          cb({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      });
      return;
    case "Fold":
      runEffect(effect.first, env, (exit) => {
        if (exit._tag === "Success") {
          try {
            const next = effect.onSuccess(exit.value);
            runEffect(next, env, cb);
          } catch (e) {
            cb({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        } else {
          if (exit.cause._tag === "Fail") {
            try {
              const next = effect.onFailure(exit.cause.error);
              runEffect(next, env, cb);
            } catch (e) {
              cb({ _tag: "Failure", cause: Cause.die(e) as any });
            }
          } else {
            cb(exit as any);
          }
        }
      });
      return;
    case "Fork":
      // Fork is not expected in this context; treat as succeed with undefined
      cb({ _tag: "Success", value: undefined as any });
      return;
  }
}
