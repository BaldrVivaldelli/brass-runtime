import { makeCircuitBreaker, CircuitBreakerConfig, CircuitBreakerError } from "../core/runtime/circuitBreaker";
import type { HttpClientFn, HttpMiddleware, HttpError } from "./client";
import type { Exit } from "../core/types/effect";
import { registerHttpEffect } from "./effectRunner";

export type HttpCircuitBreakerConfig = CircuitBreakerConfig & {
  /** Key resolver for per-origin circuit breakers. Default: per-origin. */
  perOrigin?: boolean;
};

/**
 * HTTP middleware that wraps requests in a circuit breaker.
 * When the circuit opens, requests fail fast with CircuitBreakerOpen error.
 */
export function withCircuitBreaker(config: HttpCircuitBreakerConfig = {}): HttpMiddleware {
  if (config.perOrigin) {
    // Per-origin circuit breakers
    const breakers = new Map<string, ReturnType<typeof makeCircuitBreaker>>();
    
    const getBreaker = (url: string) => {
      try {
        const origin = new URL(url).origin;
        if (!breakers.has(origin)) {
          breakers.set(origin, makeCircuitBreaker(config));
        }
        return breakers.get(origin)!;
      } catch {
        // Invalid URL — use a global breaker
        if (!breakers.has("__global__")) {
          breakers.set("__global__", makeCircuitBreaker(config));
        }
        return breakers.get("__global__")!;
      }
    };

    return (next: HttpClientFn): HttpClientFn => (req) => {
      const breaker = getBreaker(req.url);
      return protectLazy(breaker, next, req) as any;
    };
  }

  // Single global circuit breaker
  const breaker = makeCircuitBreaker({
    ...config,
    isFailure: config.isFailure ?? ((e: unknown) => {
      const err = e as HttpError;
      // Don't count client errors as circuit breaker failures
      return err._tag !== "BadUrl" && err._tag !== "Abort";
    }),
  });

  return (next: HttpClientFn): HttpClientFn => (req) => {
    return protectLazy(breaker, next, req) as any;
  };
}

function protectLazy(
  breaker: ReturnType<typeof makeCircuitBreaker>,
  next: HttpClientFn,
  req: Parameters<HttpClientFn>[0],
) {
  return {
    _tag: "Async" as const,
    register: (env: unknown, cb: (exit: Exit<HttpError | CircuitBreakerError, unknown>) => void) => {
      let cancel: (() => void) | undefined;
      try {
        const deferred = {
          _tag: "Async" as const,
          register: (innerEnv: unknown, innerCb: (exit: Exit<HttpError, unknown>) => void) =>
            registerHttpEffect(next(req) as any, innerEnv, innerCb as any),
        };
        cancel = registerHttpEffect(breaker.protect(deferred as any) as any, env, cb as any);
      } catch (error) {
        cb({
          _tag: "Failure",
          cause: {
            _tag: "Fail",
            error: { _tag: "FetchError", message: String(error) } satisfies HttpError,
          },
        });
      }
      return () => cancel?.();
    },
  };
}
