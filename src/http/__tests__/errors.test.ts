import { describe, expect, it } from "vitest";

import {
  formatHttpError,
  httpErrorStatus,
  isAbortHttpError,
  isCircuitBreakerOpen,
  isFetchHttpError,
  isHttpError,
  isKnownHttpError,
  isRetryableHttpError,
  isRetryableHttpStatus,
  isTimeoutHttpError,
  isValidationError,
  matchHttpError,
  toHttpError,
} from "../errors";
import type { HttpError } from "../client";
import type { ValidationError } from "../validation";

describe("HTTP error helpers", () => {
  it("narrows known HTTP and validation errors", () => {
    const timeout: HttpError = {
      _tag: "Timeout",
      timeoutMs: 100,
      message: "timed out",
    };
    const validation: ValidationError = {
      _tag: "ValidationError",
      message: "bad body",
      body: "{}",
      issues: [],
      phase: "response",
    };

    expect(isHttpError(timeout)).toBe(true);
    expect(isValidationError(validation)).toBe(true);
    expect(isKnownHttpError(validation)).toBe(true);
    expect(isCircuitBreakerOpen({ _tag: "CircuitBreakerOpen", openSince: 1, failures: 2 })).toBe(true);
  });

  it("matches and formats errors", () => {
    const error: HttpError = {
      _tag: "PoolClosed",
      key: "api",
      message: "closed",
    };

    const matched = matchHttpError(error, {
      PoolClosed: (err) => err.key,
      default: () => "fallback",
    });

    expect(matched).toBe("api");
    expect(formatHttpError(error)).toBe("closed");
    expect(formatHttpError("wat")).toBe("wat");
  });

  it("classifies abort, timeout, fetch, status, and retryable errors", () => {
    const abort: HttpError = { _tag: "Abort" };
    const timeout: HttpError = { _tag: "Timeout", timeoutMs: 100, message: "slow" };
    const poolTimeout: HttpError = { _tag: "PoolTimeout", key: "api", timeoutMs: 50, message: "queued" };
    const badGateway: HttpError = { _tag: "FetchError", message: "upstream", status: 503 };
    const notFound: HttpError = { _tag: "FetchError", message: "missing", status: 404 };

    expect(isAbortHttpError(abort)).toBe(true);
    expect(isTimeoutHttpError(timeout)).toBe(true);
    expect(isTimeoutHttpError(poolTimeout)).toBe(true);
    expect(isFetchHttpError(badGateway)).toBe(true);
    expect(httpErrorStatus(badGateway)).toBe(503);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpError(timeout)).toBe(true);
    expect(isRetryableHttpError(poolTimeout)).toBe(true);
    expect(isRetryableHttpError(badGateway)).toBe(true);
    expect(isRetryableHttpError(notFound)).toBe(false);
    expect(isRetryableHttpError(abort)).toBe(false);
    expect(formatHttpError(badGateway)).toBe("HTTP 503: upstream");
  });

  it("normalizes external and Axios-like errors into HttpError", () => {
    const aborted = new AbortController();
    aborted.abort();

    expect(toHttpError(new Error("cancelled"), { signal: aborted.signal })).toEqual({ _tag: "Abort" });
    expect(toHttpError(Object.assign(new Error("cancelled"), { code: "ERR_CANCELED" }))).toEqual({ _tag: "Abort" });

    expect(toHttpError(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }), {
      timeoutMs: 1500,
      phase: "request",
    })).toEqual({
      _tag: "Timeout",
      timeoutMs: 1500,
      phase: "request",
      message: "timeout",
    });

    const retryAfter = new Date(Date.now() + 10_000).toUTCString();
    const axiosLike = Object.assign(new Error("Request failed with status code 503"), {
      isAxiosError: true,
      code: "ERR_BAD_RESPONSE",
      response: {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "retry-after": retryAfter },
      },
    });
    const mapped = toHttpError(axiosLike);

    expect(mapped).toMatchObject({
      _tag: "FetchError",
      message: "Request failed with status code 503",
      code: "ERR_BAD_RESPONSE",
      status: 503,
      statusText: "Service Unavailable",
    });
    expect((mapped as Extract<HttpError, { _tag: "FetchError" }>).retryAfterMs).toBeGreaterThan(0);
    expect(isRetryableHttpError(mapped)).toBe(true);
    expect(formatHttpError(mapped)).toBe("HTTP 503 Service Unavailable: Request failed with status code 503");
  });
});
