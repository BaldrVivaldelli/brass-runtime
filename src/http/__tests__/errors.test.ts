import { describe, expect, it } from "vitest";

import {
  formatHttpError,
  isCircuitBreakerOpen,
  isHttpError,
  isKnownHttpError,
  isValidationError,
  matchHttpError,
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
});
