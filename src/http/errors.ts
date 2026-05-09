import type { CircuitBreakerError } from "../core/runtime/circuitBreaker";
import type { HttpError } from "./client";
import type { ValidationError } from "./validation";

export type KnownHttpError = HttpError | ValidationError | CircuitBreakerError;
export type KnownHttpErrorTag = KnownHttpError["_tag"];

export type HttpErrorHandlers<R> = {
  readonly [K in KnownHttpErrorTag]?: (error: Extract<KnownHttpError, { readonly _tag: K }>) => R;
} & {
  readonly default?: (error: unknown) => R;
};

const HTTP_ERROR_TAGS: ReadonlySet<HttpError["_tag"]> = new Set([
  "Abort",
  "BadUrl",
  "FetchError",
  "Timeout",
  "PoolRejected",
  "PoolTimeout",
  "PoolClosed",
  "BatchSplitError",
]);

export function isHttpError(error: unknown): error is HttpError {
  return hasTag(error) && HTTP_ERROR_TAGS.has(error._tag as HttpError["_tag"]);
}

export function isValidationError(error: unknown): error is ValidationError {
  return hasTag(error) && error._tag === "ValidationError";
}

export function isCircuitBreakerOpen(error: unknown): error is CircuitBreakerError {
  return hasTag(error) && error._tag === "CircuitBreakerOpen";
}

export function isKnownHttpError(error: unknown): error is KnownHttpError {
  return isHttpError(error) || isValidationError(error) || isCircuitBreakerOpen(error);
}

export function matchHttpError<R>(
  error: unknown,
  handlers: HttpErrorHandlers<R>,
): R | undefined {
  if (isKnownHttpError(error)) {
    const handler = handlers[error._tag] as ((value: KnownHttpError) => R) | undefined;
    if (handler) return handler(error);
  }
  return handlers.default?.(error);
}

export function formatHttpError(error: unknown): string {
  if (isValidationError(error)) {
    const phase = error.phase ? `${error.phase} ` : "";
    return `${phase}validation failed: ${error.message}`;
  }

  if (isCircuitBreakerOpen(error)) {
    return `Circuit breaker is open after ${error.failures} failure(s)`;
  }

  if (!isHttpError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error._tag) {
    case "Abort":
      return "HTTP request aborted";
    case "BadUrl":
    case "FetchError":
    case "PoolRejected":
    case "PoolTimeout":
    case "PoolClosed":
    case "BatchSplitError":
      return error.message;
    case "Timeout":
      return error.message;
  }
}

function hasTag(error: unknown): error is { readonly _tag: string } {
  return typeof error === "object" && error !== null && typeof (error as any)._tag === "string";
}
