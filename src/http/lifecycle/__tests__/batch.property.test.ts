// src/http/lifecycle/__tests__/batch.property.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import type { Async } from "../../../core/types/asyncEffect";
import { asyncSucceed, asyncFail } from "../../../core/types/asyncEffect";
import { Cause } from "../../../core/types/effect";
import type { Exit } from "../../../core/types/effect";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../../client";
import { withBatch } from "../batch";
import type { BatchConfig, BatchEventCallback } from "../batch";
import { registerHttpEffect } from "../../effectRunner";

// ---------------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------------

/** Arbitrary for a valid HttpRequest */
const arbHttpRequest: fc.Arbitrary<HttpRequest> = fc.record({
  method: fc.constantFrom("GET" as const, "POST" as const, "PUT" as const, "DELETE" as const),
  url: fc.constantFrom("/api/batch", "/users", "/items", "/data", "/graphql"),
  headers: fc
    .array(
      fc.tuple(
        fc.constantFrom("x-request-id", "x-custom", "authorization", "content-type"),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      ),
      { minLength: 0, maxLength: 3 },
    )
    .map((entries) => Object.fromEntries(entries)),
});

/** Arbitrary for a non-empty batch key string */
const arbBatchKey: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary for a batch size within valid range */
const arbBatchSize = (min: number = 2, max: number = 20): fc.Arbitrary<number> =>
  fc.integer({ min, max });

/** Arbitrary for a valid HttpWireResponse */
const arbHttpWireResponse: fc.Arbitrary<HttpWireResponse> = fc.record({
  status: fc.constantFrom(200, 201, 204, 400, 404, 500),
  statusText: fc.constantFrom("OK", "Created", "Not Found", "Error"),
  headers: fc.constant({} as Record<string, string>),
  bodyText: fc.string({ minLength: 0, maxLength: 100 }),
  ms: fc.integer({ min: 1, max: 1000 }),
});

/** Arbitrary for HttpError variants */
const arbHttpError: fc.Arbitrary<HttpError> = fc.oneof(
  fc.constant({ _tag: "Abort" } as HttpError),
  fc.string({ minLength: 1, maxLength: 50 }).map(
    (msg) => ({ _tag: "FetchError", message: msg }) as HttpError,
  ),
  fc.integer({ min: 100, max: 60000 }).map(
    (ms) => ({ _tag: "Timeout", timeoutMs: ms, message: `Timeout after ${ms}ms` }) as HttpError,
  ),
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock next function that captures the coalesced request and
 * returns a controllable response.
 */
function createMockNext(responseFactory: (req: HttpRequest) => HttpWireResponse): {
  next: HttpClientFn;
  captured: () => HttpRequest[];
  dispatched: () => boolean;
} {
  const capturedReqs: HttpRequest[] = [];
  let hasDispatched = false;
  const next: HttpClientFn = (req) => {
    capturedReqs.push(req);
    hasDispatched = true;
    return asyncSucceed(responseFactory(req));
  };
  return { next, captured: () => capturedReqs, dispatched: () => hasDispatched };
}

/**
 * Creates a mock next function that fails with the given error.
 */
function createFailingNext(error: HttpError): {
  next: HttpClientFn;
  dispatched: () => boolean;
} {
  let hasDispatched = false;
  const next: HttpClientFn = (_req) => {
    hasDispatched = true;
    return asyncFail(error);
  };
  return { next, dispatched: () => hasDispatched };
}

/**
 * Creates a mock next function that returns an Async effect we can control.
 * Useful for testing post-dispatch cancellation.
 */
function createDeferredNext(): {
  next: HttpClientFn;
  resolve: (res: HttpWireResponse) => void;
  reject: (err: HttpError) => void;
  dispatched: () => boolean;
  abortSignal: () => AbortSignal | undefined;
} {
  let resolveRef: ((res: HttpWireResponse) => void) | undefined;
  let rejectRef: ((err: HttpError) => void) | undefined;
  let hasDispatched = false;
  let signal: AbortSignal | undefined;

  const next: HttpClientFn = (req) => {
    hasDispatched = true;
    signal = (req.init as any)?.signal;
    return {
      _tag: "Async",
      register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        resolveRef = (res) => cb({ _tag: "Success", value: res });
        rejectRef = (err) => cb({ _tag: "Failure", cause: Cause.fail(err) });
        return undefined;
      },
    };
  };

  return {
    next,
    resolve: (res) => resolveRef?.(res),
    reject: (err) => rejectRef?.(err),
    dispatched: () => hasDispatched,
    abortSignal: () => signal,
  };
}

/**
 * Helper to register an effect and collect its result.
 */
function runEffect(effect: Async<unknown, HttpError, HttpWireResponse>): {
  result: () => Exit<HttpError, HttpWireResponse> | undefined;
  cancel: () => void;
} {
  let exitResult: Exit<HttpError, HttpWireResponse> | undefined;
  let cancelFn: (() => void) | undefined;

  const cancel = registerHttpEffect(effect, undefined, (exit) => {
    exitResult = exit;
  });
  cancelFn = cancel;

  return {
    result: () => exitResult,
    cancel: () => cancelFn?.(),
  };
}

/**
 * Creates a standard BatchConfig for testing.
 */
function makeBatchConfig(opts: {
  key?: string;
  windowMs?: number;
  maxBatchSize?: number;
  splitFn?: (res: HttpWireResponse, reqs: readonly HttpRequest[]) => HttpWireResponse[];
  coalesceFn?: (reqs: readonly HttpRequest[]) => HttpRequest;
  batchKeyFn?: (req: HttpRequest) => string;
}): BatchConfig {
  return {
    windowMs: opts.windowMs ?? 100,
    maxBatchSize: opts.maxBatchSize ?? 100,
    batchKey: opts.batchKeyFn ?? (() => opts.key ?? "batch-key"),
    batch: {
      coalesce: opts.coalesceFn ?? ((reqs) => ({
        method: "POST",
        url: "/batch",
        body: JSON.stringify(reqs.map((r) => r.url)),
      })),
      split: opts.splitFn ?? ((res, reqs) =>
        reqs.map((_, i) => ({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: `response-${i}`,
          ms: 1,
        }))
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe("batch middleware property tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Property 1: Split length mismatch produces BatchSplitError
   *
   * For any batch of N requests, if the `split` function returns an array of
   * length M where M ≠ N, then all N callers SHALL receive an HttpError with
   * tag "BatchSplitError".
   *
   * **Validates: Requirements 1.4**
   */
  it("Property 1: Split length mismatch produces BatchSplitError", () => {
    fc.assert(
      fc.property(
        arbBatchSize(2, 10),
        fc.integer({ min: 0, max: 20 }),
        arbHttpRequest,
        (n, mOffset, baseReq) => {
          // Ensure M ≠ N
          const m = mOffset === n ? mOffset + 1 : mOffset;

          const config = makeBatchConfig({
            maxBatchSize: n,
            splitFn: (_res, _reqs) =>
              Array.from({ length: m }, () => ({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "x",
                ms: 1,
              })),
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "batch-response",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register N callers
          const callers = Array.from({ length: n }, (_, i) => {
            const req = { ...baseReq, url: `${baseReq.url}/${i}` };
            return runEffect(client(req));
          });

          // The last caller triggers maxBatchSize dispatch
          // All callers should receive BatchSplitError
          for (const caller of callers) {
            const exit = caller.result();
            expect(exit).toBeDefined();
            expect(exit!._tag).toBe("Failure");
            if (exit!._tag === "Failure" && exit!.cause._tag === "Fail") {
              expect(exit!.cause.error._tag).toBe("BatchSplitError");
              const err = exit!.cause.error as { _tag: "BatchSplitError"; expected: number; actual: number };
              expect(err.expected).toBe(n);
              expect(err.actual).toBe(m);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 2: Timer is not reset by subsequent requests
   *
   * For any Batch_Group with an active timer, when additional requests with the
   * same Batch_Key join the group, the original timer deadline SHALL remain
   * unchanged (the timer is never reset or extended).
   *
   * **Validates: Requirements 2.2**
   */
  it("Property 2: Timer is not reset by subsequent requests", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 500 }),
        fc.integer({ min: 2, max: 5 }),
        arbHttpRequest,
        (windowMs, extraCount, baseReq) => {
          const config = makeBatchConfig({ windowMs, maxBatchSize: 100 });
          const { next, dispatched } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // First request starts the timer
          runEffect(client(baseReq));

          // Advance half the window
          vi.advanceTimersByTime(Math.floor(windowMs / 2));

          // Add more requests (should NOT reset the timer)
          for (let i = 0; i < extraCount; i++) {
            runEffect(client({ ...baseReq, url: `${baseReq.url}/${i}` }));
          }

          // Advance the remaining half of the original window
          vi.advanceTimersByTime(Math.ceil(windowMs / 2));

          // The batch should have dispatched at the original deadline
          expect(dispatched()).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 3: Timer expiry dispatches all collected requests
   *
   * For any Batch_Group, when the Batch_Window timer expires, the `coalesce`
   * method SHALL be invoked with exactly the set of requests that were added
   * to the group during the window.
   *
   * **Validates: Requirements 2.3**
   */
  it("Property 3: Timer expiry dispatches all collected requests", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 500 }),
        fc.array(arbHttpRequest, { minLength: 1, maxLength: 8 }),
        (windowMs, requests) => {
          let coalescedRequests: readonly HttpRequest[] | undefined;

          const config = makeBatchConfig({
            windowMs,
            maxBatchSize: 10000,
            coalesceFn: (reqs) => {
              coalescedRequests = reqs;
              return { method: "POST", url: "/batch", body: "batched" };
            },
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register all requests
          for (const req of requests) {
            runEffect(client(req));
          }

          // Advance past the window
          vi.advanceTimersByTime(windowMs + 1);

          // coalesce should have been called with all requests
          expect(coalescedRequests).toBeDefined();
          expect(coalescedRequests!.length).toBe(requests.length);
          for (let i = 0; i < requests.length; i++) {
            expect(coalescedRequests![i]).toEqual(requests[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 4: Response distribution preserves index correspondence
   *
   * For any batch of N requests that completes successfully, the i-th caller
   * SHALL receive exactly the i-th element from the array returned by `split`,
   * for all i in [0, N).
   *
   * **Validates: Requirements 3.2**
   */
  it("Property 4: Response distribution preserves index correspondence", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 2, maxLength: 8 }),
        fc.array(arbHttpWireResponse, { minLength: 2, maxLength: 8 }),
        (requests, responsePool) => {
          // Ensure we have enough responses for the requests
          const responses = requests.map((_, i) => responsePool[i % responsePool.length]);

          const config = makeBatchConfig({
            windowMs: 50,
            maxBatchSize: 10000,
            splitFn: (_res, _reqs) => responses,
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "batch",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Trigger dispatch
          vi.advanceTimersByTime(51);

          // Each caller should receive the response at their index
          for (let i = 0; i < callers.length; i++) {
            const exit = callers[i].result();
            expect(exit).toBeDefined();
            expect(exit!._tag).toBe("Success");
            if (exit!._tag === "Success") {
              expect(exit!.value).toEqual(responses[i]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 5: Batch failure propagates uniformly
   *
   * For any Batch_Group where the batched request fails with an HttpError E,
   * all callers in the group SHALL receive the same error E.
   *
   * **Validates: Requirements 3.3**
   */
  it("Property 5: Batch failure propagates uniformly", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 2, maxLength: 8 }),
        arbHttpError,
        (requests, error) => {
          const config = makeBatchConfig({
            windowMs: 50,
            maxBatchSize: 10000,
          });

          const { next } = createFailingNext(error);

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Trigger dispatch
          vi.advanceTimersByTime(51);

          // All callers should receive the same error
          for (const caller of callers) {
            const exit = caller.result();
            expect(exit).toBeDefined();
            expect(exit!._tag).toBe("Failure");
            if (exit!._tag === "Failure" && exit!.cause._tag === "Fail") {
              expect(exit!.cause.error).toEqual(error);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 6: Pre-dispatch cancellation removes caller from group
   *
   * For any Batch_Group with N callers (N > 1), if one caller cancels before
   * dispatch, the group SHALL contain exactly N-1 callers, and the cancelled
   * caller SHALL receive an interrupt signal.
   *
   * **Validates: Requirements 4.1**
   */
  it("Property 6: Pre-dispatch cancellation removes caller from group", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 3, maxLength: 8 }),
        fc.integer({ min: 0, max: 100 }),
        (requests, cancelIdxRaw) => {
          const cancelIdx = cancelIdxRaw % requests.length;
          let coalescedCount = 0;

          const config = makeBatchConfig({
            windowMs: 100,
            maxBatchSize: 10000,
            coalesceFn: (reqs) => {
              coalescedCount = reqs.length;
              return { method: "POST", url: "/batch", body: "batched" };
            },
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Cancel one caller before dispatch
          callers[cancelIdx].cancel();

          // The cancelled caller should receive an interrupt
          const cancelledExit = callers[cancelIdx].result();
          expect(cancelledExit).toBeDefined();
          expect(cancelledExit!._tag).toBe("Failure");
          if (cancelledExit!._tag === "Failure") {
            expect(cancelledExit!.cause._tag).toBe("Interrupt");
          }

          // Trigger dispatch
          vi.advanceTimersByTime(101);

          // coalesce should have been called with N-1 requests
          expect(coalescedCount).toBe(requests.length - 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 7: Total pre-dispatch cancellation prevents dispatch
   *
   * For any Batch_Group, if all callers cancel before the Batch_Window expires,
   * no network request SHALL be dispatched and the timer SHALL be cleared.
   *
   * **Validates: Requirements 4.2**
   */
  it("Property 7: Total pre-dispatch cancellation prevents dispatch", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 1, maxLength: 8 }),
        (requests) => {
          const config = makeBatchConfig({
            windowMs: 100,
            maxBatchSize: 10000,
          });

          const { next, dispatched } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Cancel all callers before dispatch
          for (const caller of callers) {
            caller.cancel();
          }

          // Advance past the window
          vi.advanceTimersByTime(200);

          // No dispatch should have occurred
          expect(dispatched()).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 8: Post-dispatch cancellation isolates callers
   *
   * For any dispatched Batch_Group with N callers (N > 1), if one caller
   * cancels after dispatch, the remaining N-1 callers SHALL still receive
   * their responses when the batch completes.
   *
   * **Validates: Requirements 4.3**
   */
  it("Property 8: Post-dispatch cancellation isolates callers", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 3, maxLength: 8 }),
        fc.integer({ min: 0, max: 100 }),
        (requests, cancelIdxRaw) => {
          const cancelIdx = cancelIdxRaw % requests.length;

          const config = makeBatchConfig({
            windowMs: 50,
            maxBatchSize: 10000,
          });

          const deferred = createDeferredNext();

          const middleware = withBatch(config);
          const client = middleware(deferred.next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Trigger dispatch via timer
          vi.advanceTimersByTime(51);
          expect(deferred.dispatched()).toBe(true);

          // Cancel one caller after dispatch
          callers[cancelIdx].cancel();

          // The cancelled caller should receive interrupt
          const cancelledExit = callers[cancelIdx].result();
          expect(cancelledExit).toBeDefined();
          expect(cancelledExit!._tag).toBe("Failure");
          if (cancelledExit!._tag === "Failure") {
            expect(cancelledExit!.cause._tag).toBe("Interrupt");
          }

          // Resolve the batch
          const responses = requests.map((_, i) => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: `response-${i}`,
            ms: 1,
          }));

          // Use a split that returns correct number of responses
          // Since the cancelled caller is still in the waiters array at dispatch time,
          // we need to resolve with the full set
          deferred.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "batch",
            ms: 1,
          });

          // Remaining callers should still get their responses
          for (let i = 0; i < callers.length; i++) {
            if (i === cancelIdx) continue;
            const exit = callers[i].result();
            expect(exit).toBeDefined();
            expect(exit!._tag).toBe("Success");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 9: Total post-dispatch cancellation aborts underlying request
   *
   * For any dispatched Batch_Group, if all callers cancel after dispatch,
   * the underlying request SHALL be aborted via AbortController.
   *
   * **Validates: Requirements 4.4**
   */
  it("Property 9: Total post-dispatch cancellation aborts underlying request", () => {
    fc.assert(
      fc.property(
        fc.array(arbHttpRequest, { minLength: 1, maxLength: 8 }),
        (requests) => {
          const config = makeBatchConfig({
            windowMs: 50,
            maxBatchSize: 10000,
          });

          const deferred = createDeferredNext();

          const middleware = withBatch(config);
          const client = middleware(deferred.next);

          // Register all callers
          const callers = requests.map((req) => runEffect(client(req)));

          // Trigger dispatch via timer
          vi.advanceTimersByTime(51);
          expect(deferred.dispatched()).toBe(true);

          // Cancel all callers after dispatch
          for (const caller of callers) {
            caller.cancel();
          }

          // The abort signal should have been triggered
          const signal = deferred.abortSignal();
          expect(signal).toBeDefined();
          expect(signal!.aborted).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10: Immediate dispatch at maxBatchSize
   *
   * For any configured maxBatchSize M, when the M-th request joins a
   * Batch_Group, the batch SHALL be dispatched immediately without waiting
   * for the timer to expire.
   *
   * **Validates: Requirements 5.2**
   */
  it("Property 10: Immediate dispatch at maxBatchSize", () => {
    fc.assert(
      fc.property(
        arbBatchSize(2, 15),
        arbHttpRequest,
        (maxBatchSize, baseReq) => {
          let dispatchedCount = 0;

          const config = makeBatchConfig({
            windowMs: 5000,
            maxBatchSize,
            coalesceFn: (reqs) => {
              dispatchedCount = reqs.length;
              return { method: "POST", url: "/batch", body: "batched" };
            },
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Register exactly maxBatchSize requests (no timer advance needed)
          for (let i = 0; i < maxBatchSize; i++) {
            runEffect(client({ ...baseReq, url: `${baseReq.url}/${i}` }));
          }

          // Dispatch should have happened immediately (no timer advance)
          expect(dispatchedCount).toBe(maxBatchSize);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 11: Fresh group after maxBatchSize dispatch
   *
   * For any Batch_Key K, after a Batch_Group for K is dispatched due to
   * reaching maxBatchSize, a new request for K SHALL create a new Batch_Group
   * with a fresh timer.
   *
   * **Validates: Requirements 5.3**
   */
  it("Property 11: Fresh group after maxBatchSize dispatch", () => {
    fc.assert(
      fc.property(
        arbBatchSize(2, 10),
        arbHttpRequest,
        (maxBatchSize, baseReq) => {
          let dispatchCount = 0;

          const config = makeBatchConfig({
            windowMs: 100,
            maxBatchSize,
            coalesceFn: (reqs) => {
              dispatchCount++;
              return { method: "POST", url: "/batch", body: String(reqs.length) };
            },
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config);
          const client = middleware(next);

          // Fill first batch to maxBatchSize (triggers immediate dispatch)
          for (let i = 0; i < maxBatchSize; i++) {
            runEffect(client({ ...baseReq, url: `${baseReq.url}/${i}` }));
          }
          expect(dispatchCount).toBe(1);

          // Add one more request — should create a new group
          runEffect(client({ ...baseReq, url: `${baseReq.url}/extra` }));

          // The new group should dispatch after its own timer
          vi.advanceTimersByTime(101);
          expect(dispatchCount).toBe(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 12: Batch key bypass (empty or throwing)
   *
   * For any request where the `batchKey` function returns an empty string or
   * throws an error, the request SHALL bypass batching entirely and be forwarded
   * directly to the next middleware layer.
   *
   * **Validates: Requirements 6.2, 6.3**
   */
  it("Property 12: Batch key bypass (empty or throwing)", () => {
    fc.assert(
      fc.property(
        arbHttpRequest,
        fc.boolean(),
        (req, shouldThrow) => {
          let directCallCount = 0;

          const config = makeBatchConfig({
            windowMs: 100,
            maxBatchSize: 100,
            batchKeyFn: (_r) => {
              if (shouldThrow) throw new Error("key error");
              return "";
            },
          });

          const next: HttpClientFn = (r) => {
            directCallCount++;
            return asyncSucceed({
              status: 200,
              statusText: "OK",
              headers: {},
              bodyText: "direct",
              ms: 1,
            });
          };

          const middleware = withBatch(config);
          const client = middleware(next);

          // The request should bypass batching and go directly to next
          const caller = runEffect(client(req));

          // Should have been called directly (not batched)
          expect(directCallCount).toBe(1);

          // Should resolve immediately
          const exit = caller.result();
          expect(exit).toBeDefined();
          expect(exit!._tag).toBe("Success");
          if (exit!._tag === "Success") {
            expect(exit!.value.bodyText).toBe("direct");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 13: Batch key grouping invariant
   *
   * For any set of requests processed by the Batch_Middleware, two requests
   * SHALL be in the same Batch_Group if and only if they have the same
   * non-empty Batch_Key and arrive within the same Batch_Window.
   *
   * **Validates: Requirements 6.4**
   */
  it("Property 13: Batch key grouping invariant", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbHttpRequest, fc.constantFrom("key-a", "key-b", "key-c")),
          { minLength: 2, maxLength: 10 },
        ),
        (requestsWithKeys) => {
          const dispatchedGroups: { key: string; count: number }[] = [];

          const config: BatchConfig = {
            windowMs: 100,
            maxBatchSize: 10000,
            batchKey: (_req) => {
              // We'll use a lookup to assign keys
              const idx = requestsWithKeys.findIndex(([r]) => r === _req);
              if (idx >= 0) return requestsWithKeys[idx][1];
              return "unknown";
            },
            batch: {
              coalesce: (reqs) => {
                return { method: "POST", url: "/batch", body: String(reqs.length) };
              },
              split: (_res, reqs) =>
                reqs.map(() => ({
                  status: 200,
                  statusText: "OK",
                  headers: {},
                  bodyText: "ok",
                  ms: 1,
                })),
            },
          };

          // Track dispatches via onEvent
          const events: { type: string; batchKey: string; batchSize?: number }[] = [];
          const onEvent: BatchEventCallback = (ev) => {
            events.push(ev);
          };

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config, onEvent);
          const client = middleware(next);

          // Register all requests (within the same window)
          for (const [req] of requestsWithKeys) {
            runEffect(client(req));
          }

          // Trigger dispatch
          vi.advanceTimersByTime(101);

          // Count expected groups by key
          const expectedGroups = new Map<string, number>();
          for (const [, key] of requestsWithKeys) {
            expectedGroups.set(key, (expectedGroups.get(key) ?? 0) + 1);
          }

          // Count dispatch events by key
          const dispatchEvents = events.filter((e) => e.type === "batch-dispatch");
          expect(dispatchEvents.length).toBe(expectedGroups.size);

          for (const ev of dispatchEvents) {
            expect(expectedGroups.has(ev.batchKey)).toBe(true);
            expect(ev.batchSize).toBe(expectedGroups.get(ev.batchKey));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 14: Batch event emission correctness
   *
   * For any Batch_Group dispatch of N requests with key K, the middleware SHALL
   * emit exactly one "batch-dispatch" event with `batchKey === K` and
   * `batchSize === N`, and exactly N-1 "batch-hit" events (one for each request
   * after the first).
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it("Property 14: Batch event emission correctness", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        arbBatchKey,
        arbHttpRequest,
        (n, key, baseReq) => {
          const events: { type: string; batchKey: string; batchSize?: number }[] = [];
          const onEvent: BatchEventCallback = (ev) => {
            events.push(ev);
          };

          const config = makeBatchConfig({
            windowMs: 100,
            maxBatchSize: 10000,
            batchKeyFn: () => key,
          });

          const { next } = createMockNext(() => ({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          }));

          const middleware = withBatch(config, onEvent);
          const client = middleware(next);

          // Register N requests
          for (let i = 0; i < n; i++) {
            runEffect(client({ ...baseReq, url: `${baseReq.url}/${i}` }));
          }

          // Trigger dispatch
          vi.advanceTimersByTime(101);

          // Should have exactly N-1 batch-hit events
          const hitEvents = events.filter((e) => e.type === "batch-hit");
          expect(hitEvents.length).toBe(n - 1);
          for (const ev of hitEvents) {
            expect(ev.batchKey).toBe(key);
          }

          // Should have exactly 1 batch-dispatch event
          const dispatchEvents = events.filter((e) => e.type === "batch-dispatch");
          expect(dispatchEvents.length).toBe(1);
          expect(dispatchEvents[0].batchKey).toBe(key);
          expect(dispatchEvents[0].batchSize).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});
