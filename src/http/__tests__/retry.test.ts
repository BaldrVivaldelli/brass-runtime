import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { asyncSucceed, asyncFail } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

/**
 * Mock the WASM retry planner module so we can track `drop()` calls.
 */
const mockDrop = vi.fn();
const mockStart = vi.fn().mockReturnValue(42);
const mockNextDelayMs = vi.fn().mockReturnValue(500);

vi.mock("../retry/wasmRetryPlanner", () => ({
  makeWasmRetryPlanner: () => ({
    start: mockStart,
    nextDelayMs: mockNextDelayMs,
    drop: mockDrop,
  }),
}));

// Import withRetry AFTER the mock is set up
import { withRetry } from "../retry/retry";

const rt = Runtime.make({});
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const makeResponse = (status: number = 200): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain" },
  bodyText: "ok",
  ms: 10,
});

const makeRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  url: "https://example.com/api",
  ...overrides,
});

describe("WASM planner drop on cancellation", () => {
  beforeEach(() => {
    mockDrop.mockClear();
    mockStart.mockClear();
    mockNextDelayMs.mockClear();
    mockStart.mockReturnValue(42);
    // Return a long delay so we have time to interrupt mid-sleep
    mockNextDelayMs.mockReturnValue(5000);
  });

  it("drop() is called exactly once when the retry effect is interrupted mid-sleep", async () => {
    // Client always returns a retryable status (503) to trigger retry + sleep
    const client: HttpClientFn = (_req: HttpRequest) => asyncSucceed(makeResponse(503));

    const retryClient = withRetry({
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      engine: "wasm",
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

    // drop() should have been called exactly once via safeDrop
    expect(mockDrop).toHaveBeenCalledTimes(1);
    expect(mockDrop).toHaveBeenCalledWith(42);
  });

  it("no double-drop occurs on normal completion (non-retryable response)", async () => {
    // First call returns 503 (retryable), second returns 200 (success)
    let requestCount = 0;
    const client: HttpClientFn = (_req: HttpRequest) => {
      requestCount++;
      if (requestCount === 1) return asyncSucceed(makeResponse(503));
      return asyncSucceed(makeResponse(200));
    };

    // Short delay so the test completes quickly
    mockNextDelayMs.mockReturnValue(5);

    const retryClient = withRetry({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      engine: "wasm",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    // Run the effect to completion
    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    // Should succeed with the 200 response
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.status).toBe(200);
    }

    // drop() should have been called exactly once (no double-drop)
    expect(mockDrop).toHaveBeenCalledTimes(1);
    expect(mockDrop).toHaveBeenCalledWith(42);
  });

  it("no double-drop occurs on non-retryable error (Abort)", async () => {
    const client: HttpClientFn = (_req: HttpRequest) =>
      asyncFail({ _tag: "Abort", message: "user cancelled" } as HttpError);

    const retryClient = withRetry({
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      engine: "wasm",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    // Should fail with the Abort error (non-retryable)
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect((exit.cause.error as any)._tag).toBe("Abort");
    }

    // drop() should have been called exactly once
    expect(mockDrop).toHaveBeenCalledTimes(1);
    expect(mockDrop).toHaveBeenCalledWith(42);
  });

  it("no double-drop occurs on retry exhaustion", async () => {
    // Client always returns 503 (retryable)
    const client: HttpClientFn = (_req: HttpRequest) => asyncSucceed(makeResponse(503));

    // Short delay, and return undefined after maxRetries to signal exhaustion
    let callCount = 0;
    mockNextDelayMs.mockImplementation(() => {
      callCount++;
      return 5; // short delay
    });

    const retryClient = withRetry({
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      engine: "wasm",
    })(client);

    const req = makeRequest();
    const effect = retryClient(req);

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
      rt.unsafeRunAsync(effect, resolve);
    });

    // Should succeed with the last 503 response (retries exhausted, returns last response)
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.status).toBe(503);
    }

    // drop() should have been called exactly once (no double-drop)
    expect(mockDrop).toHaveBeenCalledTimes(1);
    expect(mockDrop).toHaveBeenCalledWith(42);
  });
});
