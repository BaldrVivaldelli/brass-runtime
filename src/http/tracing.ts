import type { Tracer } from "../core/runtime/tracing";
import type { HttpClientFn, HttpMiddleware, HttpRequest } from "./client";

/**
 * HTTP middleware that creates a span for each request.
 */
export function withTracing(tracer: Tracer): HttpMiddleware {
  return (next: HttpClientFn): HttpClientFn => (req: HttpRequest) => {
    return tracer.span(
      `HTTP ${req.method} ${req.url}`,
      next(req),
      {
        "http.method": req.method,
        "http.url": req.url,
        ...(req.headers?.["content-type"] ? { "http.content_type": req.headers["content-type"] } : {}),
      }
    ) as any;
  };
}
