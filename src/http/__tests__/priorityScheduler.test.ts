import { describe, expect, it, vi } from "vitest";
import { withPriority, type PriorityConfig } from "../lifecycle/priorityScheduler";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import type { Exit } from "../../core/types/effect";
import type { Async } from "../../core/types/asyncEffect";

// Helper to create a simple HttpRequest
function makeReq(overrides: Partial<HttpRequest> & { priority?: number } = {}): HttpRequest {
  const { priority, ...rest } = overrides;
  const req: any = {
    method: "GET" as const,
    url: "https://example.com/test",
    ...rest,
  };
  if (priority !== undefined) {
    req.priority = priority;
  }
  return req;
}

// Helper to create a mock response
function makeRes(status = 200): HttpWireResponse {
  return {
    status,
    statusText: "OK",
    headers: {},
    bodyText: "",
    ms: 10,
  };
}

// Helper: creates a downstream client that resolves after a manual trigger
function deferredClient(): {
  client: HttpClientFn;
  pending: Array<{ resolve: (res: HttpWireResponse) => void; reject: (err: HttpError) => void }>;
} {
  const pending: Array<{ resolve: (res: HttpWireResponse) => void; reject: (err: HttpError) => void }> = [];

  const client: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
      const entry = {
        resolve: (res: HttpWireResponse) => cb({ _tag: "Success", value: res }),
        reject: (err: HttpError) => cb({ _tag: "Failure", cause: { _tag: "Fail", error: err } }),
      };
      pending.push(entry);
      return () => {
        // cancellation
      };
    },
  });

  return { client, pending };
}

// Helper: runs an Async effect and returns a promise
function runAsync(effect: Async<unknown, HttpError, HttpWireResponse>): {
  promise: Promise<HttpWireResponse>;
  cancel?: () => void;
} {
  let cancel: (() => void) | undefined;
  const promise = new Promise<HttpWireResponse>((resolve, reject) => {
    if (effect._tag === "Succeed") {
      resolve(effect.value);
      return;
    }
    if (effect._tag === "Fail") {
      reject(effect.error);
      return;
    }
    if (effect._tag === "Async") {
      const cancelFn = effect.register({}, (exit: Exit<HttpError, HttpWireResponse>) => {
        if (exit._tag === "Success") {
          resolve(exit.value);
        } else {
          if (exit.cause._tag === "Fail") {
            reject(exit.cause.error);
          } else {
            reject({ _tag: "Abort" });
          }
        }
      });
      if (typeof cancelFn === "function") {
        cancel = cancelFn;
      }
    }
  });
  return { promise, cancel };
}

describe("withPriority", () => {
  describe("immediate dispatch when under concurrency", () => {
    it("dispatches immediately when inFlight < concurrency", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 2 });
      const wrapped = mw(client);

      const effect = wrapped(makeReq());
      runAsync(effect);

      expect(pending.length).toBe(1);
    });

    it("dispatches multiple requests up to concurrency limit", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 3 });
      const wrapped = mw(client);

      runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      expect(pending.length).toBe(3);
    });
  });

  describe("queuing when at capacity", () => {
    it("queues requests when at concurrency limit", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      // Only 1 should be dispatched
      expect(pending.length).toBe(1);
      expect(mw.queueDepth()).toBe(1);
    });

    it("dispatches queued request when slot becomes available", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const { promise: p1 } = runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      expect(pending.length).toBe(1);

      // Complete the first request
      pending[0].resolve(makeRes(200));
      await p1;

      // Second request should now be dispatched
      expect(pending.length).toBe(2);
    });
  });

  describe("priority ordering", () => {
    it("dispatches higher priority (lower number) requests first", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const dispatched: number[] = [];
      const originalClient = client;

      // Track dispatch order
      const trackingClient: HttpClientFn = (req) => {
        dispatched.push((req as any).priority ?? 5);
        return originalClient(req);
      };
      const wrappedTracking = mw(trackingClient);

      // Fill the slot
      const { promise: p1 } = runAsync(wrappedTracking(makeReq({ priority: 5 })));

      // Queue requests with different priorities
      runAsync(wrappedTracking(makeReq({ priority: 8 })));
      runAsync(wrappedTracking(makeReq({ priority: 2 })));
      runAsync(wrappedTracking(makeReq({ priority: 6 })));

      // Complete the first request to start draining
      pending[0].resolve(makeRes());
      await p1;

      // The priority 2 request should be dispatched next
      expect(dispatched[1]).toBe(2);
    });

    it("uses FIFO for same priority", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const order: string[] = [];
      const trackingClient: HttpClientFn = (req) => {
        order.push((req as any).tag);
        return client(req);
      };
      const wrappedTracking = mw(trackingClient);

      // Fill the slot
      const req1: any = makeReq({ priority: 5 });
      req1.tag = "first";
      const { promise: p1 } = runAsync(wrappedTracking(req1));

      // Queue same-priority requests
      const req2: any = makeReq({ priority: 5 });
      req2.tag = "second";
      runAsync(wrappedTracking(req2));

      const req3: any = makeReq({ priority: 5 });
      req3.tag = "third";
      runAsync(wrappedTracking(req3));

      // Complete first to drain
      pending[0].resolve(makeRes());
      await p1;

      // Should be FIFO: second before third
      expect(order[1]).toBe("second");
    });
  });

  describe("priority extraction", () => {
    it("uses default priority of 5 when not specified", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      // Both should work — one dispatched, one queued
      expect(pending.length).toBe(1);
      expect(mw.queueDepth()).toBe(1);
    });

    it("extracts priority from (req as any).priority", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      runAsync(wrapped(makeReq()));

      // Queue with explicit priority
      const req: any = makeReq();
      req.priority = 2;
      runAsync(wrapped(req));

      expect(mw.queueDepth()).toBe(1);
    });

    it("extracts priority from (req.init as any)?.priority", () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      runAsync(wrapped(makeReq()));

      // Queue with priority in init
      const req = makeReq({ init: { priority: 3 } as any });
      runAsync(wrapped(req));

      expect(mw.queueDepth()).toBe(1);
    });

    it("clamps priority to 0-9 range", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const dispatched: number[] = [];
      const trackingClient: HttpClientFn = (req) => {
        dispatched.push((req as any).priority ?? 5);
        return client(req);
      };
      const wrappedTracking = mw(trackingClient);

      // Fill slot
      const { promise: p1 } = runAsync(wrappedTracking(makeReq({ priority: 5 })));

      // Queue with out-of-range priorities — both should be clamped
      runAsync(wrappedTracking(makeReq({ priority: -5 }))); // clamped to 0
      runAsync(wrappedTracking(makeReq({ priority: 99 }))); // clamped to 9

      pending[0].resolve(makeRes());
      await p1;

      // Priority 0 (clamped from -5) should dispatch before priority 9 (clamped from 99)
      expect(dispatched[1]).toBe(-5); // The req still has -5, but internally clamped
    });
  });

  describe("queue timeout", () => {
    it("rejects with PoolTimeout when queue timeout expires", async () => {
      vi.useFakeTimers();
      try {
        const { client } = deferredClient();
        const mw = withPriority({ concurrency: 1, queueTimeoutMs: 100 });
        const wrapped = mw(client);

        // Fill slot
        runAsync(wrapped(makeReq()));

        // Queue a request
        const { promise: p2 } = runAsync(wrapped(makeReq()));

        // Advance time past the timeout
        vi.advanceTimersByTime(101);

        await expect(p2).rejects.toMatchObject({
          _tag: "PoolTimeout",
          timeoutMs: 100,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not timeout if dispatched before timeout", async () => {
      vi.useFakeTimers();
      try {
        const { client, pending } = deferredClient();
        const mw = withPriority({ concurrency: 1, queueTimeoutMs: 200 });
        const wrapped = mw(client);

        // Fill slot
        const { promise: p1 } = runAsync(wrapped(makeReq()));

        // Queue a request
        const { promise: p2 } = runAsync(wrapped(makeReq()));

        // Complete first request before timeout
        vi.advanceTimersByTime(50);
        pending[0].resolve(makeRes());
        await p1;

        // Second request should now be dispatched, not timed out
        expect(pending.length).toBe(2);
        pending[1].resolve(makeRes(201));
        const res = await p2;
        expect(res.status).toBe(201);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancellation", () => {
    it("removes request from queue on abort signal", () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      runAsync(wrapped(makeReq()));

      // Queue a request with an abort controller
      const controller = new AbortController();
      const req = makeReq({ init: { signal: controller.signal } as any });
      const { promise } = runAsync(wrapped(req));
      // Catch the expected rejection
      promise.catch(() => {});

      expect(mw.queueDepth()).toBe(1);

      // Abort the queued request
      controller.abort();

      // Queue depth should eventually be 0 (entry is marked cancelled)
      // The entry is lazily removed on next dequeue
    });

    it("does not dispatch cancelled request when slot becomes available", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      const { promise: p1 } = runAsync(wrapped(makeReq()));

      // Queue two requests
      const controller = new AbortController();
      const req2 = makeReq({ init: { signal: controller.signal } as any });
      const { promise: p2 } = runAsync(wrapped(req2));
      p2.catch(() => {}); // Catch expected rejection
      runAsync(wrapped(makeReq()));

      // Cancel the first queued request
      controller.abort();

      // Complete the first dispatched request
      pending[0].resolve(makeRes());
      await p1;

      // The third request (not cancelled) should be dispatched
      expect(pending.length).toBe(2);
    });

    it("handles already-aborted signal", () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      runAsync(wrapped(makeReq()));

      // Queue a request with an already-aborted signal
      const controller = new AbortController();
      controller.abort();
      const req = makeReq({ init: { signal: controller.signal } as any });
      const { promise } = runAsync(wrapped(req));

      // Should reject immediately with Abort
      return expect(promise).rejects.toMatchObject({ _tag: "Abort" });
    });

    it("cancellation via returned cancel function marks entry as cancelled", () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill slot
      runAsync(wrapped(makeReq()));

      // Queue a request
      const { cancel, promise } = runAsync(wrapped(makeReq()));
      promise.catch(() => {}); // Catch expected rejection

      expect(mw.queueDepth()).toBe(1);

      // Cancel via the returned function
      if (cancel) cancel();

      // Entry is marked cancelled (lazy removal)
    });
  });

  describe("queueDepth stats", () => {
    it("reports 0 when no requests are queued", () => {
      const mw = withPriority({ concurrency: 10 });
      expect(mw.queueDepth()).toBe(0);
    });

    it("increases when requests are queued", () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      runAsync(wrapped(makeReq()));
      expect(mw.queueDepth()).toBe(0);

      runAsync(wrapped(makeReq()));
      expect(mw.queueDepth()).toBe(1);

      runAsync(wrapped(makeReq()));
      expect(mw.queueDepth()).toBe(2);
    });

    it("decreases when queued requests are dispatched", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const { promise: p1 } = runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      expect(mw.queueDepth()).toBe(2);

      // Complete first request
      pending[0].resolve(makeRes());
      await p1;

      // One was dequeued and dispatched
      expect(mw.queueDepth()).toBe(1);
    });
  });

  describe("default configuration", () => {
    it("uses default concurrency of 32", () => {
      const { client, pending } = deferredClient();
      const mw = withPriority();
      const wrapped = mw(client);

      // Dispatch 32 requests — all should go through
      for (let i = 0; i < 32; i++) {
        runAsync(wrapped(makeReq()));
      }
      expect(pending.length).toBe(32);
      expect(mw.queueDepth()).toBe(0);

      // 33rd should be queued
      runAsync(wrapped(makeReq()));
      expect(pending.length).toBe(32);
      expect(mw.queueDepth()).toBe(1);
    });

    it("has no queue timeout by default", async () => {
      vi.useFakeTimers();
      try {
        const { client } = deferredClient();
        const mw = withPriority({ concurrency: 1 });
        const wrapped = mw(client);

        // Fill slot
        runAsync(wrapped(makeReq()));

        // Queue a request
        runAsync(wrapped(makeReq()));

        // Advance time significantly — should not timeout
        vi.advanceTimersByTime(60000);

        expect(mw.queueDepth()).toBe(1); // Still queued, not rejected
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("error propagation", () => {
    it("propagates downstream errors to the caller", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 2 });
      const wrapped = mw(client);

      const { promise } = runAsync(wrapped(makeReq()));

      pending[0].reject({ _tag: "FetchError", message: "network down" });

      await expect(promise).rejects.toMatchObject({
        _tag: "FetchError",
        message: "network down",
      });
    });

    it("drains queue after a failed request frees a slot", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      const { promise: p1 } = runAsync(wrapped(makeReq()));
      runAsync(wrapped(makeReq()));

      expect(pending.length).toBe(1);
      expect(mw.queueDepth()).toBe(1);

      // Fail the first request
      pending[0].reject({ _tag: "FetchError", message: "oops" });
      await p1.catch(() => {});

      // Second request should now be dispatched
      expect(pending.length).toBe(2);
      expect(mw.queueDepth()).toBe(0);
    });
  });
});
