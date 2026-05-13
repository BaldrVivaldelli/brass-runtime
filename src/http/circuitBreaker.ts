import { makeCircuitBreaker, CircuitBreakerConfig, CircuitBreakerError } from "../core/runtime/circuitBreaker";
import type { HttpClientFn, HttpMiddleware, HttpError, HttpRequest } from "./client";
import type { Exit } from "../core/types/effect";
import { registerHttpEffect } from "./effectRunner";
import type { AdaptiveLimiter } from "./adaptiveLimiter";
import { getHttpRequestPolicy } from "./requestPolicy";

export type HttpCircuitBreakerConfig = CircuitBreakerConfig & {
  /** Key resolver for per-origin circuit breakers. Default: per-origin. */
  perOrigin?: boolean;
  /** Optional limiter to notify when this breaker is already/opened. Defaults to `next.adaptiveLimiter` when available. */
  adaptiveLimiter?: Pick<AdaptiveLimiter, "keyResolver" | "markCircuitOpen">;
  /** Optional resolver when the limiter key differs from the request URL origin/global fallback. */
  adaptiveLimiterKey?: (req: HttpRequest) => string;
};

/**
 * HTTP middleware that wraps requests in a circuit breaker.
 * When the circuit opens, requests fail fast with CircuitBreakerOpen error.
 */
export function withCircuitBreaker(config: HttpCircuitBreakerConfig = {}): HttpMiddleware {
  if (config.perOrigin) {
    // Per-origin circuit breakers
    const breakers = new Map<string, ReturnType<typeof makeCircuitBreaker>>();
    
    const getBreaker = (url: string, onOpen: () => void) => {
      try {
        const origin = new URL(url).origin;
        if (!breakers.has(origin)) {
          breakers.set(origin, makeCircuitBreaker({
            ...config,
            onStateChange: (from, to) => {
              config.onStateChange?.(from, to);
              if (to === "open") onOpen();
            },
          }));
        }
        return breakers.get(origin)!;
      } catch {
        // Invalid URL — use a global breaker
        if (!breakers.has("__global__")) {
          breakers.set("__global__", makeCircuitBreaker({
            ...config,
            onStateChange: (from, to) => {
              config.onStateChange?.(from, to);
              if (to === "open") onOpen();
            },
          }));
        }
        return breakers.get("__global__")!;
      }
    };

    return (next: HttpClientFn): HttpClientFn => (req) => {
      const limiter = resolveAdaptiveLimiter(config, next);
      const limiterKey = resolveAdaptiveLimiterKey(config, limiter, req);
      const onOpen = () => limiterKey !== undefined && limiter?.markCircuitOpen(limiterKey);
      const breaker = getBreaker(req.url, onOpen);
      return protectLazy(breaker, next, req, onOpen) as any;
    };
  }

  // Single global circuit breaker
  const breaker = makeCircuitBreaker({
    ...config,
    onStateChange: (from, to) => {
      config.onStateChange?.(from, to);
    },
    isFailure: config.isFailure ?? ((e: unknown) => {
      const err = e as HttpError;
      // Don't count client errors as circuit breaker failures
      return err._tag !== "BadUrl" && err._tag !== "Abort";
    }),
  });

  return (next: HttpClientFn): HttpClientFn => (req) => {
    const limiter = resolveAdaptiveLimiter(config, next);
    const limiterKey = resolveAdaptiveLimiterKey(config, limiter, req);
    const onOpen = () => limiterKey !== undefined && limiter?.markCircuitOpen(limiterKey);
    return protectLazy(breaker, next, req, onOpen) as any;
  };
}

function protectLazy(
  breaker: ReturnType<typeof makeCircuitBreaker>,
  next: HttpClientFn,
  req: Parameters<HttpClientFn>[0],
  onOpen?: () => void,
) {
  return {
    _tag: "Async" as const,
    register: (env: unknown, cb: (exit: Exit<HttpError | CircuitBreakerError, unknown>) => void) => {
      let cancel: (() => void) | undefined;
      try {
        if (breaker.state() === "open") onOpen?.();
        const finish = (exit: Exit<HttpError | CircuitBreakerError, unknown>) => {
          if (breaker.state() === "open") onOpen?.();
          cb(exit);
        };
        const deferred = {
          _tag: "Async" as const,
          register: (innerEnv: unknown, innerCb: (exit: Exit<HttpError, unknown>) => void) =>
            registerHttpEffect(next(req) as any, innerEnv, innerCb as any),
        };
        cancel = registerHttpEffect(breaker.protect(deferred as any) as any, env, finish as any);
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

function resolveAdaptiveLimiter(
  config: HttpCircuitBreakerConfig,
  next: HttpClientFn,
): Pick<AdaptiveLimiter, "keyResolver" | "markCircuitOpen"> | undefined {
  return config.adaptiveLimiter ?? (next as any).adaptiveLimiter;
}

function resolveAdaptiveLimiterKey(
  config: HttpCircuitBreakerConfig,
  limiter: Pick<AdaptiveLimiter, "keyResolver" | "markCircuitOpen"> | undefined,
  req: HttpRequest,
): string | undefined {
  if (!limiter) return undefined;
  if (config.adaptiveLimiterKey) return config.adaptiveLimiterKey(req);
  const poolKey = getHttpRequestPolicy(req).poolKey;
  if (poolKey) return poolKey;
  if (limiter.keyResolver === "global") return "global";
  try {
    const url = new URL(req.url);
    if (limiter.keyResolver === "host") return url.host;
    return url.origin;
  } catch {
    return "global";
  }
}
