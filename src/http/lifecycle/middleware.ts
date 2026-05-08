// src/http/lifecycle/middleware.ts
import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import { now } from "./timing";

/**
 * Event object passed to the `withLogging` middleware's logger callback on each
 * request lifecycle phase (request, response, or error).
 *
 * @property phase - The lifecycle phase that triggered this event: `"request"` before
 *   the request is sent, `"response"` on success, or `"error"` on failure.
 * @property req - The original HttpRequest being executed.
 * @property res - The HttpWireResponse received from the server. Present only when
 *   `phase` is `"response"`.
 * @property error - The HttpError that occurred. Present only when `phase` is `"error"`.
 * @property durationMs - Elapsed time in milliseconds since the request was initiated.
 *   Present only when `phase` is `"response"` or `"error"`.
 */
export type LogEvent = {
  phase: "request" | "response" | "error";
  req: HttpRequest;
  res?: HttpWireResponse;
  error?: HttpError;
  durationMs?: number;
};

/**
 * Creates a middleware that injects a Bearer token into the Authorization header.
 * The token is obtained asynchronously via the provided `tokenProvider` Async_Effect.
 * If the token provider fails, the error propagates to the caller unchanged.
 *
 * @param tokenProvider - A function returning an Async_Effect that resolves to the
 *   Bearer token string. Called on every request to support token rotation.
 * @returns An HttpMiddleware that prepends `Authorization: Bearer <token>` to outgoing requests.
 *
 * @example
 * ```typescript
 * import { makeLifecycleClient, withAuth } from "./index";
 * import { asyncSucceed } from "../../core/types/asyncEffect";
 *
 * const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
 *   .with(withAuth(() => asyncSucceed("my-secret-token")));
 *
 * // All requests now include Authorization: Bearer my-secret-token
 * const result = client({ method: "GET", url: "/users" });
 * ```
 */
export function withAuth(
  tokenProvider: () => Async<unknown, HttpError, string>
): HttpMiddleware {
  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      return asyncFlatMap(tokenProvider(), (token: string) => {
        const modifiedReq: HttpRequest = {
          ...req,
          headers: {
            ...(req.headers ?? {}),
            Authorization: `Bearer ${token}`,
          },
        };
        return next(modifiedReq);
      });
    };
  };
}

/**
 * Creates a middleware that logs request, response, and error events through a
 * user-supplied logger callback. The logger is invoked synchronously at each phase;
 * if it throws, the error is swallowed to avoid disrupting the request pipeline.
 *
 * @param logger - A synchronous callback invoked with a {@link LogEvent} for each
 *   lifecycle phase (`"request"`, `"response"`, `"error"`). Exceptions thrown by
 *   the logger are silently caught.
 * @returns An HttpMiddleware that instruments requests with logging side-effects.
 *
 * @example
 * ```typescript
 * import { makeLifecycleClient, withLogging } from "./index";
 * import type { LogEvent } from "./index";
 *
 * const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
 *   .with(withLogging((event: LogEvent) => {
 *     console.log(`[${event.phase}] ${event.req.method} ${event.req.url} ${event.durationMs ?? ""}ms`);
 *   }));
 *
 * const result = client({ method: "GET", url: "/health" });
 * ```
 */
export function withLogging(
  logger: (event: LogEvent) => void
): HttpMiddleware {
  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      // Log request phase (swallow errors)
      try {
        logger({ phase: "request", req });
      } catch {
        // swallow
      }

      const startedAt = now();

      return asyncFold(
        next(req),
        (error: HttpError): Async<unknown, HttpError, HttpWireResponse> => {
          const durationMs = Math.round(now() - startedAt);
          try {
            logger({ phase: "error", req, error, durationMs });
          } catch {
            // swallow
          }
          return asyncFail(error);
        },
        (res: HttpWireResponse): Async<unknown, HttpError, HttpWireResponse> => {
          const durationMs = Math.round(now() - startedAt);
          try {
            logger({ phase: "response", req, res, durationMs });
          } catch {
            // swallow
          }
          return asyncSucceed(res);
        }
      );
    };
  };
}

/**
 * Creates a middleware that transforms HTTP responses after retrieval. The
 * transformation is applied to both cached and network responses. Cached
 * responses are stored in their original (untransformed) form, so the transform
 * runs on every access.
 *
 * If the transform function throws, the error is propagated as a `FetchError`.
 *
 * @param fn - A synchronous function that receives the response and the original
 *   request, and returns a modified HttpWireResponse. Must not return `undefined`.
 * @returns An HttpMiddleware that applies the transform to every successful response.
 *
 * @example
 * ```typescript
 * import { makeLifecycleClient, withResponseTransform } from "./index";
 *
 * const client = makeLifecycleClient({ baseUrl: "https://api.example.com" })
 *   .with(withResponseTransform((res, req) => ({
 *     ...res,
 *     headers: { ...res.headers, "x-request-url": req.url },
 *   })));
 *
 * // Responses now include the x-request-url header
 * const result = client({ method: "GET", url: "/data" });
 * ```
 */
export function withResponseTransform(
  fn: (res: HttpWireResponse, req: HttpRequest) => HttpWireResponse
): HttpMiddleware {
  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      return asyncFold(
        next(req),
        (error: HttpError): Async<unknown, HttpError, HttpWireResponse> => {
          return asyncFail(error);
        },
        (res: HttpWireResponse): Async<unknown, HttpError, HttpWireResponse> => {
          try {
            const transformed = fn(res, req);
            return asyncSucceed(transformed);
          } catch (e) {
            return asyncFail({ _tag: "FetchError", message: String(e) } as HttpError);
          }
        }
      );
    };
  };
}
