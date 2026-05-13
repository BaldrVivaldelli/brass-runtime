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

// ---------------------------------------------------------------------------
// External error classification helpers
// ---------------------------------------------------------------------------

export type ToHttpErrorOptions = { signal?: AbortSignal; message?: string | ((error: unknown) => string); timeoutMs?: number; phase?: string };

const TIMEOUT_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const ABORT_CODES = new Set(["ERR_CANCELED", "ABORT_ERR"]);

export function isExternalAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || ABORT_CODES.has(String(record.code ?? ""));
}

export function isExternalTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.name === "TimeoutError" || TIMEOUT_CODES.has(String(record.code ?? ""));
}

export function toHttpError(error: unknown, options: ToHttpErrorOptions = {}): HttpError {
  if (isHttpError(error)) return error;

  if (options.signal?.aborted || isExternalAbortError(error)) {
    return { _tag: "Abort" };
  }

  const status = externalStatus(error);
  const statusText = externalStatusText(error);
  const code = externalCode(error);
  const message = resolveMessage(error, options.message);

  if (isExternalTimeoutError(error)) {
    return {
      _tag: "Timeout",
      timeoutMs: options.timeoutMs ?? 0,
      phase: (options.phase ?? "request") as "request" | "queue" | "retry",
      message,
    };
  }

  return {
    _tag: "FetchError",
    message,
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(statusText !== undefined ? { statusText } : {}),
    ...(retryAfterMsFromExternal(error) !== undefined ? { retryAfterMs: retryAfterMsFromExternal(error) } : {}),
  } as HttpError;
}

function externalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function externalStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const status = response?.status ?? record.status ?? record.statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function externalStatusText(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const statusText = response?.statusText ?? record.statusText ?? record.statusMessage;
  return typeof statusText === "string" && statusText.length > 0 ? statusText : undefined;
}

function retryAfterMsFromExternal(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const headers = response?.headers ?? record.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const headerRecord = headers as Record<string, unknown>;
  const raw = headerRecord["retry-after"] ?? headerRecord["Retry-After"];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

function resolveMessage(error: unknown, message: ToHttpErrorOptions["message"]): string {
  if (typeof message === "function") return message(error);
  if (typeof message === "string") return message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const value = (error as Record<string, unknown>).message;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return String(error);
}
