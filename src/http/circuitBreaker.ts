import { makeCircuitBreaker, CircuitBreakerConfig, CircuitBreakerError } from "../core/runtime/circuitBreaker";
import type { HttpClientFn, HttpMiddleware, HttpError } from "./client";
import { asyncFail } from "../core/types/asyncEffect";

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
      return breaker.protect(next(req)) as any;
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
    return breaker.protect(next(req)) as any;
  };
}
