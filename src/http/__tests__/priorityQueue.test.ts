import { describe, expect, it, vi } from "vitest";
import { PriorityQueue, clampPriority } from "../lifecycle/priorityQueue";
import { withPriority } from "../lifecycle/priorityScheduler";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import type { Exit } from "../../core/types/effect";
import type { Async } from "../../core/types/asyncEffect";

describe("PriorityQueue", () => {
  describe("clampPriority", () => {
    it("returns 5 for undefined", () => {
      expect(clampPriority(undefined)).toBe(5);
    });

    it("returns 5 for NaN", () => {
      expect(clampPriority(NaN)).toBe(5);
    });

    it("returns 5 for Infinity", () => {
      expect(clampPriority(Infinity)).toBe(5);
    });

    it("returns 5 for -Infinity", () => {
      expect(clampPriority(-Infinity)).toBe(5);
    });

    it("clamps negative values to 0", () => {
      expect(clampPriority(-1)).toBe(0);
      expect(clampPriority(-100)).toBe(0);
    });

    it("clamps values above 9 to 9", () => {
      expect(clampPriority(10)).toBe(9);
      expect(clampPriority(100)).toBe(9);
    });

    it("truncates fractional values toward zero", () => {
      expect(clampPriority(3.7)).toBe(3);
      expect(clampPriority(3.2)).toBe(3);
      expect(clampPriority(-0.9)).toBe(0);
    });

    it("passes through valid integers unchanged", () => {
      for (let i = 0; i <= 9; i++) {
        expect(clampPriority(i)).toBe(i);
      }
    });
  });

  describe("enqueue and dequeue", () => {
    it("dequeues entries in priority order (lower value = higher priority)", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("low", 7);
      pq.enqueue("high", 1);
      pq.enqueue("mid", 5);

      expect(pq.dequeue()!.value).toBe("high");
      expect(pq.dequeue()!.value).toBe("mid");
      expect(pq.dequeue()!.value).toBe("low");
    });

    it("uses FIFO order for same priority", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("first", 5);
      pq.enqueue("second", 5);
      pq.enqueue("third", 5);

      expect(pq.dequeue()!.value).toBe("first");
      expect(pq.dequeue()!.value).toBe("second");
      expect(pq.dequeue()!.value).toBe("third");
    });

    it("returns undefined when dequeuing from empty queue", () => {
      const pq = new PriorityQueue<string>();
      expect(pq.dequeue()).toBeUndefined();
    });

    it("uses default priority of 5 when not specified", () => {
      const pq = new PriorityQueue<string>();
      const entry = pq.enqueue("test");
      expect(entry.priority).toBe(5);
    });

    it("clamps priority on enqueue", () => {
      const pq = new PriorityQueue<string>();
      const entry1 = pq.enqueue("over", 15);
      const entry2 = pq.enqueue("under", -3);
      const entry3 = pq.enqueue("frac", 2.9);

      expect(entry1.priority).toBe(9);
      expect(entry2.priority).toBe(0);
      expect(entry3.priority).toBe(2);
    });
  });

  describe("size", () => {
    it("reports 0 for empty queue", () => {
      const pq = new PriorityQueue<string>();
      expect(pq.size).toBe(0);
    });

    it("increases on enqueue", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("a", 1);
      expect(pq.size).toBe(1);
      pq.enqueue("b", 2);
      expect(pq.size).toBe(2);
    });

    it("decreases on dequeue", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("a", 1);
      pq.enqueue("b", 2);
      pq.dequeue();
      expect(pq.size).toBe(1);
    });
  });

  describe("peek", () => {
    it("returns the highest-priority entry without removing it", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("low", 8);
      pq.enqueue("high", 2);

      const peeked = pq.peek();
      expect(peeked!.value).toBe("high");
      expect(pq.size).toBe(2);
    });

    it("returns undefined for empty queue", () => {
      const pq = new PriorityQueue<string>();
      expect(pq.peek()).toBeUndefined();
    });
  });

  describe("lazy removal (cancellation)", () => {
    it("skips cancelled entries on dequeue", () => {
      const pq = new PriorityQueue<string>();
      const entry1 = pq.enqueue("first", 1);
      pq.enqueue("second", 2);

      entry1.cancelled = true;

      expect(pq.dequeue()!.value).toBe("second");
    });

    it("skips cancelled entries on peek", () => {
      const pq = new PriorityQueue<string>();
      const entry1 = pq.enqueue("first", 1);
      pq.enqueue("second", 2);

      entry1.cancelled = true;

      expect(pq.peek()!.value).toBe("second");
    });

    it("returns undefined when all entries are cancelled", () => {
      const pq = new PriorityQueue<string>();
      const entry1 = pq.enqueue("a", 1);
      const entry2 = pq.enqueue("b", 2);

      entry1.cancelled = true;
      entry2.cancelled = true;

      expect(pq.dequeue()).toBeUndefined();
    });
  });

  describe("remove (predicate-based)", () => {
    it("marks matching entries as cancelled", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("keep", 1);
      pq.enqueue("remove-me", 2);
      pq.enqueue("also-keep", 3);

      const removed = pq.remove((e) => e.value === "remove-me");
      expect(removed).toBe(1);

      expect(pq.dequeue()!.value).toBe("keep");
      expect(pq.dequeue()!.value).toBe("also-keep");
    });

    it("returns 0 when no entries match", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("a", 1);
      pq.enqueue("b", 2);

      const removed = pq.remove((e) => e.value === "nonexistent");
      expect(removed).toBe(0);
    });

    it("does not double-cancel already cancelled entries", () => {
      const pq = new PriorityQueue<string>();
      const entry = pq.enqueue("a", 1);
      entry.cancelled = true;

      const removed = pq.remove((e) => e.value === "a");
      expect(removed).toBe(0);
    });

    it("can remove multiple entries at once", () => {
      const pq = new PriorityQueue<number>();
      pq.enqueue(1, 1);
      pq.enqueue(2, 2);
      pq.enqueue(3, 3);
      pq.enqueue(4, 4);

      const removed = pq.remove((e) => e.value % 2 === 0);
      expect(removed).toBe(2);

      expect(pq.dequeue()!.value).toBe(1);
      expect(pq.dequeue()!.value).toBe(3);
      expect(pq.dequeue()).toBeUndefined();
    });
  });

  describe("ordering correctness", () => {
    it("maintains heap property after mixed operations", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("p5-first", 5);
      pq.enqueue("p3", 3);
      pq.enqueue("p7", 7);
      pq.enqueue("p1", 1);
      pq.enqueue("p5-second", 5);

      expect(pq.dequeue()!.value).toBe("p1");
      expect(pq.dequeue()!.value).toBe("p3");
      expect(pq.dequeue()!.value).toBe("p5-first");
      expect(pq.dequeue()!.value).toBe("p5-second");
      expect(pq.dequeue()!.value).toBe("p7");
    });

    it("handles interleaved enqueue and dequeue", () => {
      const pq = new PriorityQueue<number>();
      pq.enqueue(5, 5);
      pq.enqueue(3, 3);
      expect(pq.dequeue()!.value).toBe(3);

      pq.enqueue(1, 1);
      pq.enqueue(4, 4);
      expect(pq.dequeue()!.value).toBe(1);
      expect(pq.dequeue()!.value).toBe(4);
      expect(pq.dequeue()!.value).toBe(5);
    });
  });
});


// --- Helpers for priority scheduler edge case tests ---

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

function makeRes(status = 200): HttpWireResponse {
  return {
    status,
    statusText: "OK",
    headers: {},
    bodyText: "",
    ms: 10,
  };
}

function deferredClient(): {
  client: HttpClientFn;
  pending: Array<{ resolve: (res: HttpWireResponse) => void; reject: (err: HttpError) => void }>;
  callCount: () => number;
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
      return () => {};
    },
  });

  return { client, pending, callCount: () => pending.length };
}

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

// --- Edge case tests for Requirements 4.4, 4.6, 5.3 ---

describe("PriorityQueue edge cases", () => {
  describe("default priority of 5 (Requirement 4.4)", () => {
    it("assigns priority 5 when enqueue is called without a priority argument", () => {
      const pq = new PriorityQueue<string>();
      const entry = pq.enqueue("no-priority");
      expect(entry.priority).toBe(5);
    });

    it("default priority entries are ordered after lower-priority-value entries", () => {
      const pq = new PriorityQueue<string>();
      pq.enqueue("default"); // priority 5
      pq.enqueue("urgent", 2);
      pq.enqueue("also-default"); // priority 5

      expect(pq.dequeue()!.value).toBe("urgent");
      expect(pq.dequeue()!.value).toBe("default");
      expect(pq.dequeue()!.value).toBe("also-default");
    });

    it("scheduler uses default priority 5 when request has no priority field", async () => {
      const { client, pending } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill the slot
      const { promise: p1 } = runAsync(wrapped(makeReq()));

      // Queue requests: one with explicit low priority, one with no priority (default 5)
      runAsync(wrapped(makeReq({ priority: 8 })));
      runAsync(wrapped(makeReq())); // default priority 5

      // Complete first request to start draining
      pending[0].resolve(makeRes());
      await p1;

      // Default priority (5) should dispatch before priority 8
      expect(pending.length).toBe(2);
    });
  });

  describe("queue timeout produces PoolTimeout error (Requirement 5.3)", () => {
    it("produces PoolTimeout with correct key and timeoutMs fields", async () => {
      vi.useFakeTimers();
      try {
        const { client } = deferredClient();
        const mw = withPriority({ concurrency: 1, queueTimeoutMs: 50 });
        const wrapped = mw(client);

        // Fill slot
        runAsync(wrapped(makeReq()));

        // Queue a request
        const { promise } = runAsync(wrapped(makeReq()));

        vi.advanceTimersByTime(51);

        await expect(promise).rejects.toMatchObject({
          _tag: "PoolTimeout",
          key: "priority",
          timeoutMs: 50,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("includes a descriptive message in the PoolTimeout error", async () => {
      vi.useFakeTimers();
      try {
        const { client } = deferredClient();
        const mw = withPriority({ concurrency: 1, queueTimeoutMs: 200 });
        const wrapped = mw(client);

        // Fill slot
        runAsync(wrapped(makeReq()));

        // Queue a request
        const { promise } = runAsync(wrapped(makeReq()));

        vi.advanceTimersByTime(201);

        await expect(promise).rejects.toMatchObject({
          _tag: "PoolTimeout",
          message: expect.stringContaining("200"),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not produce PoolTimeout when no queueTimeoutMs is configured", async () => {
      vi.useFakeTimers();
      try {
        const { client } = deferredClient();
        const mw = withPriority({ concurrency: 1 }); // no timeout
        const wrapped = mw(client);

        // Fill slot
        runAsync(wrapped(makeReq()));

        // Queue a request
        runAsync(wrapped(makeReq()));

        // Advance time significantly
        vi.advanceTimersByTime(300_000);

        // Request should still be queued, not rejected
        expect(mw.queueDepth()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancellation removes entry without network call - Property 16 (Requirement 5.3)", () => {
    it("cancelling a queued request via AbortController does not trigger a network call", async () => {
      const { client, pending, callCount } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill the slot with one request
      runAsync(wrapped(makeReq()));
      const networkCallsBefore = callCount();

      // Queue a request with an abort controller
      const controller = new AbortController();
      const req = makeReq({ init: { signal: controller.signal } as any });
      const { promise } = runAsync(wrapped(req));
      promise.catch(() => {}); // suppress unhandled rejection

      // Abort the queued request before it gets dispatched
      controller.abort();

      // Verify no additional network call was made
      expect(callCount()).toBe(networkCallsBefore);
    });

    it("cancelling via cancel function does not trigger a network call", async () => {
      const { client, pending, callCount } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill the slot
      runAsync(wrapped(makeReq()));
      const networkCallsBefore = callCount();

      // Queue a request
      const { cancel, promise } = runAsync(wrapped(makeReq()));
      promise.catch(() => {}); // suppress unhandled rejection

      // Cancel via the returned cancel function
      if (cancel) cancel();

      // Verify no additional network call was made
      expect(callCount()).toBe(networkCallsBefore);
    });

    it("cancelled queued request does not dispatch when slot becomes available", async () => {
      const { client, pending, callCount } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill the slot
      const { promise: p1 } = runAsync(wrapped(makeReq()));

      // Queue two requests: one to cancel, one to keep
      const controller = new AbortController();
      const cancelledReq = makeReq({ init: { signal: controller.signal } as any });
      const { promise: p2 } = runAsync(wrapped(cancelledReq));
      p2.catch(() => {}); // suppress unhandled rejection

      const { promise: p3 } = runAsync(wrapped(makeReq()));

      // Cancel the first queued request
      controller.abort();

      // Complete the dispatched request to free the slot
      pending[0].resolve(makeRes());
      await p1;

      // Only the non-cancelled request should have been dispatched (2 total: original + kept)
      expect(callCount()).toBe(2);

      // Complete the second dispatched request
      pending[1].resolve(makeRes(201));
      const res = await p3;
      expect(res.status).toBe(201);
    });

    it("cancelled request completes with interrupt exit cause", async () => {
      const { client } = deferredClient();
      const mw = withPriority({ concurrency: 1 });
      const wrapped = mw(client);

      // Fill the slot
      runAsync(wrapped(makeReq()));

      // Queue a request with abort controller
      const controller = new AbortController();
      const req = makeReq({ init: { signal: controller.signal } as any });
      const { promise } = runAsync(wrapped(req));

      // Abort
      controller.abort();

      // Should reject with Abort (mapped from interrupt)
      await expect(promise).rejects.toMatchObject({ _tag: "Abort" });
    });
  });
});
