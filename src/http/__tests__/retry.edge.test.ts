import { describe, expect, it, vi } from "vitest";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { asyncSucceed, asyncFail, async as asyncRegister } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";
import { withRetry } from "../retry/retry";

const rt = Runtime.make({});
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const makeResponse = (status: number = 200, headers: Record<string, string> = {}): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain", ...headers },
  bodyText: "ok",
  ms: 10,
});

const makeRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  url: "https://example.com/api",
  ...overrides,
});

describe("Observability and cancellation edge cases", () => {
  it("no events emitted when onRetry is undefined", async () => {
    // Track all calls to next to confirm retries happen
    let callCount = 0;
    const client: HttpClientFn = (_req: HttpRequest) => {
      callCount++;
      if (callCount < 3) return asyncSucceed(makeResponse(503));
      return asyncSucceed(makeResponse(200));
    };

    // No onRetry callback provided
    const retryClient = withRetry({
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 5,
      engine: "ts",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    // Should succeed after retries
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.status).toBe(200);
    }
    // Retries happened (3 calls total: initial + 2 retries)
    expect(callCount).toBe(3);
    // No crash, no events — the test passes if no error is thrown
    // (there's no onRetry to call, so nothing should blow up)
  });

  it("respectRetryAfter: false ignores Retry-After header", async () => {
    let callCount = 0;
    const client: HttpClientFn = (_req: HttpRequest) => {
      callCount++;
      if (callCount === 1) {
        // Return 429 with a very large Retry-After (3600 seconds = 1 hour)
        return asyncSucceed(makeResponse(429, { "Retry-After": "3600" }));
      }
      return asyncSucceed(makeResponse(200));
    };

    const delays: number[] = [];
    const retryClient = withRetry({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      respectRetryAfter: false,
      engine: "ts",
      onRetry: (event) => {
        delays.push(event.delayMs);
      },
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.status).toBe(200);
    }
    expect(callCount).toBe(2);
    // The delay should be from the computed backoff (max 50ms), NOT from Retry-After (3600000ms)
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeLessThanOrEqual(50);
  });

  it("cancellation during sleep stops retry chain", async () => {
    let callCount = 0;
    const client: HttpClientFn = (_req: HttpRequest) => {
      callCount++;
      // Always return retryable status
      return asyncSucceed(makeResponse(503));
    };

    const retryClient = withRetry({
      maxRetries: 10,
      baseDelayMs: 5000,
      maxDelayMs: 10000,
      engine: "ts",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    // Fork the effect into a fiber
    const fiber = rt.fork(effect);

    // Wait for the first request to complete and the retry loop to enter sleep
    await wait(50);

    // Interrupt the fiber mid-sleep
    fiber.interrupt();

    // Wait for the fiber to complete
    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      fiber.join(resolve);
    });

    // The effect should have been interrupted
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Interrupt");
    }

    // Only 1 request should have been made (the initial one before sleep)
    expect(callCount).toBe(1);
  });

  it("cancellation during in-flight request aborts and stops", async () => {
    let callCount = 0;
    let aborted = false;

    const client: HttpClientFn = (_req: HttpRequest) => {
      callCount++;
      if (callCount === 1) {
        // First call succeeds with retryable status quickly
        return asyncSucceed(makeResponse(503));
      }
      // Second call (retry) takes a long time — simulates in-flight request
      return asyncRegister((_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        const id = setTimeout(() => {
          cb({ _tag: "Success", value: makeResponse(200) });
        }, 10000);
        return () => {
          clearTimeout(id);
          aborted = true;
        };
      });
    };

    const retryClient = withRetry({
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 5,
      engine: "ts",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    // Fork the effect
    const fiber = rt.fork(effect);

    // Wait for the first request to complete, sleep to finish, and second request to start
    await wait(50);

    // Interrupt while the second request is in-flight
    fiber.interrupt();

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      fiber.join(resolve);
    });

    // Should be interrupted
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Interrupt");
    }

    // The in-flight request should have been aborted
    expect(aborted).toBe(true);
    // No further retries after interruption
    expect(callCount).toBe(2);
  });

  it("laziness — constructing the effect triggers no side effects", () => {
    let requestExecuted = false;

    // The downstream client returns an Async that sets requestExecuted=true
    // only when the runtime actually runs it (via the register callback).
    const client: HttpClientFn = (_req: HttpRequest) => {
      return asyncRegister((_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        requestExecuted = true;
        cb({ _tag: "Success", value: makeResponse(200) });
      });
    };

    const retryClient = withRetry({
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      engine: "ts",
    })(client);

    const req = makeRequest();

    // Constructing the effect should NOT trigger the actual request execution
    const _effect = retryClient(req);

    // The register callback should not have been invoked — no I/O until the runtime runs it
    expect(requestExecuted).toBe(false);
  });

  it("retry + circuit breaker composition (breaker opens mid-sequence)", async () => {
    let callCount = 0;
    const client: HttpClientFn = (_req: HttpRequest) => {
      callCount++;
      if (callCount === 1) {
        // First call: retryable error (triggers retry)
        return asyncFail({ _tag: "FetchError", message: "network error" } as HttpError);
      }
      // Subsequent calls: circuit breaker is open
      return asyncFail({ _tag: "CircuitBreakerOpen" } as unknown as HttpError);
    };

    const events: Array<{ attempt: number }> = [];
    const retryClient = withRetry({
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 5,
      engine: "ts",
      onRetry: (event) => {
        events.push({ attempt: event.attempt });
      },
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    // Should fail with CircuitBreakerOpen (non-retryable, propagated immediately)
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect((exit.cause.error as any)._tag).toBe("CircuitBreakerOpen");
    }

    // Only 2 calls: initial request (FetchError) + 1 retry attempt (CircuitBreakerOpen)
    expect(callCount).toBe(2);
    // Only 1 retry event emitted (for the first retry, before the CircuitBreakerOpen)
    expect(events.length).toBe(1);
    expect(events[0].attempt).toBe(0);
  });
});
