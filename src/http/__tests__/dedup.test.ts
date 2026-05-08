import { describe, expect, it, vi } from "vitest";
import { withDedup } from "../lifecycle/dedup";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const runExit = <E, A>(eff: Async<unknown, E, A>): Promise<Exit<E, A>> =>
  new Promise((resolve) => {
    rt.unsafeRunAsync(eff, resolve);
  });

/** Flush microtask queue to allow fibers to start executing */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const makeResponse = (body: string = "ok", status: number = 200): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain" },
  bodyText: body,
  ms: 10,
});

/**
 * Creates a mock HttpClientFn that resolves only when manually triggered.
 * Returns the mock function and a way to track calls and resolve/reject them.
 */
function makeDelayedClient(): {
  client: HttpClientFn;
  calls: HttpRequest[];
  resolveAll: (res: HttpWireResponse) => void;
  rejectAll: (err: HttpError) => void;
} {
  const calls: HttpRequest[] = [];
  const pending: Array<{
    resolve: (res: HttpWireResponse) => void;
    reject: (err: HttpError) => void;
  }> = [];

  const client: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
      calls.push(req);
      const entry = {
        resolve: (res: HttpWireResponse) => cb({ _tag: "Success", value: res }),
        reject: (err: HttpError) => cb({ _tag: "Failure", cause: Cause.fail(err) }),
      };
      pending.push(entry);

      return () => {
        cb({ _tag: "Failure", cause: Cause.interrupt() });
      };
    },
  });

  return {
    client,
    calls,
    resolveAll: (res) => {
      for (const p of pending.splice(0)) {
        p.resolve(res);
      }
    },
    rejectAll: (err) => {
      for (const p of pending.splice(0)) {
        p.reject(err);
      }
    },
  };
}

describe("withDedup", () => {
  describe("safe method deduplication", () => {
    it("deduplicates concurrent identical GET requests into a single network call", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };
      const response = makeResponse("shared");

      // Start two concurrent requests
      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      // Allow fibers to start
      await flush();

      // Only one network call should have been made
      expect(calls.length).toBe(1);

      // Resolve the single call
      resolveAll(response);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(response);
      expect(r2).toEqual(response);
    });

    it("deduplicates HEAD requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "HEAD", url: "https://example.com/api" };
      const response = makeResponse("");

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(1);
      resolveAll(response);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(response);
      expect(r2).toEqual(response);
    });

    it("deduplicates OPTIONS requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "OPTIONS", url: "https://example.com/api" };
      const response = makeResponse("");

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(1);
      resolveAll(response);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(response);
      expect(r2).toEqual(response);
    });
  });

  describe("non-safe methods pass through", () => {
    it("does not deduplicate POST requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "POST", url: "https://example.com/api", body: "{}" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();

      // Each POST should result in its own network call
      expect(calls.length).toBe(2);

      resolveAll(makeResponse("post-response"));
      await Promise.all([p1, p2]);
    });

    it("does not deduplicate PUT requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "PUT", url: "https://example.com/api", body: "{}" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(2);
      resolveAll(makeResponse("put-response"));
      await Promise.all([p1, p2]);
    });

    it("does not deduplicate DELETE requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "DELETE", url: "https://example.com/api" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(2);
      resolveAll(makeResponse(""));
      await Promise.all([p1, p2]);
    });

    it("does not deduplicate PATCH requests", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "PATCH", url: "https://example.com/api", body: "{}" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(2);
      resolveAll(makeResponse(""));
      await Promise.all([p1, p2]);
    });
  });

  describe("error propagation", () => {
    it("propagates the same error to all waiters", async () => {
      const { client, calls, rejectAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };
      const error: HttpError = { _tag: "FetchError", message: "network down" };

      const p1 = runExit<HttpError, HttpWireResponse>(dedup(req));
      const p2 = runExit<HttpError, HttpWireResponse>(dedup(req));

      await flush();
      expect(calls.length).toBe(1);
      rejectAll(error);

      const [e1, e2] = await Promise.all([p1, p2]);

      expect(e1._tag).toBe("Failure");
      expect(e2._tag).toBe("Failure");
      if (e1._tag === "Failure" && e1.cause._tag === "Fail") {
        expect(e1.cause.error).toEqual(error);
      }
      if (e2._tag === "Failure" && e2.cause._tag === "Fail") {
        expect(e2.cause.error).toEqual(error);
      }
    });
  });

  describe("cancellation", () => {
    it("partial cancellation preserves remaining callers", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };
      const response = makeResponse("result");

      // Start two requests by directly calling register
      let cancel1: (() => void) | undefined;
      const p1 = new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
        const effect = dedup(req);
        if (effect._tag === "Async") {
          cancel1 = effect.register({}, resolve) as (() => void) | undefined;
        }
      });

      const p2 = new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
        const effect = dedup(req);
        if (effect._tag === "Async") {
          effect.register({}, resolve);
        }
      });

      expect(calls.length).toBe(1);

      // Cancel the first caller
      cancel1?.();

      // The first caller should get an interrupt
      const exit1 = await p1;
      expect(exit1._tag).toBe("Failure");
      if (exit1._tag === "Failure") {
        expect(exit1.cause._tag).toBe("Interrupt");
      }

      // Resolve the underlying request — second caller should still get the response
      resolveAll(response);
      const exit2 = await p2;
      expect(exit2._tag).toBe("Success");
      if (exit2._tag === "Success") {
        expect(exit2.value).toEqual(response);
      }
    });

    it("full cancellation aborts the underlying request", async () => {
      const abortSignals: AbortSignal[] = [];
      const client: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => ({
        _tag: "Async",
        register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          // Capture the signal from the request init
          const signal = (req.init as any)?.signal as AbortSignal | undefined;
          if (signal) abortSignals.push(signal);
          return () => {
            cb({ _tag: "Failure", cause: Cause.interrupt() });
          };
        },
      });

      const dedup = withDedup()(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // Start two requests by directly calling register
      let cancel1: (() => void) | undefined;
      let cancel2: (() => void) | undefined;

      new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
        const effect = dedup(req);
        if (effect._tag === "Async") {
          cancel1 = effect.register({}, resolve) as (() => void) | undefined;
        }
      });

      new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => {
        const effect = dedup(req);
        if (effect._tag === "Async") {
          cancel2 = effect.register({}, resolve) as (() => void) | undefined;
        }
      });

      // Cancel both callers
      cancel1?.();
      cancel2?.();

      // The abort signal should have been triggered
      expect(abortSignals.length).toBeGreaterThan(0);
      expect(abortSignals[0]!.aborted).toBe(true);
    });
  });

  describe("custom dedupKey", () => {
    it("uses custom dedupKey function when provided", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup({ dedupKey: () => "custom-key" })(client);

      const req1: HttpRequest = { method: "GET", url: "https://example.com/a" };
      const req2: HttpRequest = { method: "GET", url: "https://example.com/b" };
      const response = makeResponse("shared");

      // Different URLs but same custom key — should be deduped
      const p1 = run<HttpWireResponse>(dedup(req1));
      const p2 = run<HttpWireResponse>(dedup(req2));

      await flush();
      expect(calls.length).toBe(1);
      resolveAll(response);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(response);
      expect(r2).toEqual(response);
    });

    it("bypasses dedup when custom dedupKey throws", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup({
        dedupKey: () => { throw new Error("key error"); },
      })(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();

      // Each request should bypass dedup and make its own call
      expect(calls.length).toBe(2);
      resolveAll(makeResponse("individual"));
      await Promise.all([p1, p2]);
    });

    it("bypasses dedup when custom dedupKey returns empty string", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup({ dedupKey: () => "" })(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      const p1 = run<HttpWireResponse>(dedup(req));
      const p2 = run<HttpWireResponse>(dedup(req));

      await flush();

      // Each request should bypass dedup
      expect(calls.length).toBe(2);
      resolveAll(makeResponse("individual"));
      await Promise.all([p1, p2]);
    });
  });

  describe("different requests are not deduped", () => {
    it("does not deduplicate requests with different URLs", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req1: HttpRequest = { method: "GET", url: "https://example.com/a" };
      const req2: HttpRequest = { method: "GET", url: "https://example.com/b" };

      const p1 = run<HttpWireResponse>(dedup(req1));
      const p2 = run<HttpWireResponse>(dedup(req2));

      await flush();
      expect(calls.length).toBe(2);
      resolveAll(makeResponse("ok"));
      await Promise.all([p1, p2]);
    });
  });

  describe("cleanup after completion", () => {
    it("allows new requests after previous dedup group completes", async () => {
      const { client, calls, resolveAll } = makeDelayedClient();
      const dedup = withDedup()(client);

      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };
      const response1 = makeResponse("first");
      const response2 = makeResponse("second");

      // First request
      const p1 = run<HttpWireResponse>(dedup(req));
      await flush();
      expect(calls.length).toBe(1);
      resolveAll(response1);
      const r1 = await p1;
      expect(r1).toEqual(response1);

      // Second request after first completes — should start a new network call
      const p2 = run<HttpWireResponse>(dedup(req));
      await flush();
      expect(calls.length).toBe(2);
      resolveAll(response2);
      const r2 = await p2;
      expect(r2).toEqual(response2);
    });
  });
});
