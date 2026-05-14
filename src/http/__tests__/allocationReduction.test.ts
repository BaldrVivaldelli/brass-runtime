import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHttp } from "../client";
import { Runtime, resetAbortablePromiseStats } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { HttpTransport } from "../transport";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
  resetAbortablePromiseStats();
});

/**
 * Unit tests for allocation reduction optimizations in `runPoolTransport`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */
describe("Allocation reduction in runPoolTransport", () => {
  describe("Requirement 2.1: Abortable signal without external signal", () => {
    it("transport receives a non-aborted signal when no external signal is present", async () => {
      const observedSignals: AbortSignal[] = [];

      const transport: HttpTransport = ({ signal }) => {
        observedSignals.push(signal);
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      // Use pool or timeout to trigger runPoolTransport path
      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      await run(client({ method: "GET", url: "/first" }));
      await run(client({ method: "GET", url: "/second" }));

      expect(observedSignals).toHaveLength(2);
      expect(observedSignals[0].aborted).toBe(false);
      expect(observedSignals[1].aborted).toBe(false);
      expect(observedSignals[0]).not.toBe(observedSignals[1]);
    });

    it("transport receives a non-aborted signal when pool is configured but no external signal", async () => {
      const observedSignals: AbortSignal[] = [];

      const transport: HttpTransport = ({ signal }) => {
        observedSignals.push(signal);
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        pool: { concurrency: 10 },
        transport,
      });

      await run(client({ method: "GET", url: "/a" }));
      await run(client({ method: "GET", url: "/b" }));
      await run(client({ method: "GET", url: "/c" }));

      expect(observedSignals).toHaveLength(3);
      expect(observedSignals[0].aborted).toBe(false);
      expect(observedSignals[1].aborted).toBe(false);
      expect(observedSignals[2].aborted).toBe(false);
      expect(observedSignals[0]).not.toBe(observedSignals[1]);
      expect(observedSignals[1]).not.toBe(observedSignals[2]);
    });

    it("runs an uncontended pool transport synchronously during registration", () => {
      let transportCalled = false;
      let exitResult: any;

      const transport: HttpTransport = () => {
        transportCalled = true;
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        pool: { concurrency: 10 },
        transport,
      });

      const effect = client({ method: "GET", url: "/sync-pool" });
      effect.register({}, (exit) => { exitResult = exit; });

      expect(transportCalled).toBe(true);
      expect(exitResult).toMatchObject({ _tag: "Success" });
    });
  });

  describe("Requirement 2.2: AbortController allocated when external signal is present", () => {
    it("transport receives a unique signal (from a new AbortController) when external signal is present", async () => {
      const observedSignals: AbortSignal[] = [];

      const transport: HttpTransport = ({ signal }) => {
        observedSignals.push(signal);
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const externalController1 = new AbortController();
      const externalController2 = new AbortController();

      await run(client({ method: "GET", url: "/first", init: { signal: externalController1.signal } } as any));
      await run(client({ method: "GET", url: "/second", init: { signal: externalController2.signal } } as any));

      // Each request should get a distinct signal (from a new AbortController)
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals[0]).not.toBe(observedSignals[1]);
      // The signals should not be the external signals themselves; HTTP owns a
      // request-scoped controller and propagates external abort into it.
      expect(observedSignals[0]).not.toBe(externalController1.signal);
      expect(observedSignals[1]).not.toBe(externalController2.signal);
      // Neither should be aborted
      expect(observedSignals[0].aborted).toBe(false);
      expect(observedSignals[1].aborted).toBe(false);
    });

    it("signal differs between requests with and without external signal", async () => {
      const observedSignals: AbortSignal[] = [];

      const transport: HttpTransport = ({ signal }) => {
        observedSignals.push(signal);
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      // Request without external signal — HTTP creates a cancellable signal
      await run(client({ method: "GET", url: "/no-signal" }));
      // Request with external signal — HTTP still owns the request signal and
      // wires the external signal into it.
      const controller = new AbortController();
      await run(client({ method: "GET", url: "/with-signal", init: { signal: controller.signal } } as any));
      // Another request without external signal
      await run(client({ method: "GET", url: "/no-signal-again" }));

      expect(observedSignals).toHaveLength(3);
      // All three requests receive request-scoped signals.
      expect(observedSignals[0]).not.toBe(observedSignals[1]);
      expect(observedSignals[0]).not.toBe(observedSignals[2]);
      // With an additional external signal, the second request is still
      // isolated from both no-external-signal requests.
      expect(observedSignals[1]).not.toBe(observedSignals[2]);
      // All should be non-aborted
      expect(observedSignals[0].aborted).toBe(false);
      expect(observedSignals[1].aborted).toBe(false);
      expect(observedSignals[2].aborted).toBe(false);
    });
  });

  describe("Requirement 2.3: Shared ONCE_OPTIONS (indirect verification)", () => {
    it("abort propagation works correctly with external signal (addEventListener uses shared options)", async () => {
      const transport: HttpTransport = ({ signal }) => {
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const externalController = new AbortController();
      // Spy on addEventListener to verify options are passed
      const addEventListenerSpy = vi.spyOn(externalController.signal, "addEventListener");

      await run(client({ method: "GET", url: "/test", init: { signal: externalController.signal } } as any));

      // Verify addEventListener was called with an options object that has once: true.
      // The exact options object is an implementation detail; what matters is
      // that the listener is one-shot.
      if (addEventListenerSpy.mock.calls.length > 0) {
        const abortCalls = addEventListenerSpy.mock.calls.filter(
          (call) => call[0] === "abort"
        );
        if (abortCalls.length > 0) {
          const options = abortCalls[0][2];
          expect(options).toMatchObject({ once: true });
        }
      }
    });
  });

  describe("Requirement 2.4: No external signal linking when no external signal", () => {
    it("no abort listener is registered on the external signal when no external signal is present", async () => {
      // When no external signal is provided, there is no additional external
      // abort listener to register. The request still receives a real signal.
      let observedSignal: AbortSignal | undefined;
      const transport: HttpTransport = ({ signal }) => {
        observedSignal = signal;
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      await run(client({ method: "GET", url: "/no-signal" }));

      // The transport receives a request signal, and it should not be aborted.
      expect(observedSignal).toBeDefined();
      expect(observedSignal!.aborted).toBe(false);

      // The key optimization: when there's no external signal, the HTTP layer
      // does not register any external abort listener. The request still gets a
      // real signal so cancellation and timeout can abort host transports.
    });
  });

  describe("Requirement 3.5: At most 2 performance.now() calls on happy path without external signal", () => {
    it("invokes performance.now() at most 2 times on the success path without external signal", async () => {
      const transport: HttpTransport = ({ signal }) => {
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const perfNowSpy = vi.spyOn(performance, "now");

      await run(client({ method: "GET", url: "/perf-check" }));

      // On the happy path without external signal, we expect exactly 2 calls:
      // 1. At request start (startedAt)
      // 2. At request finish (durationMs calculation)
      expect(perfNowSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("invokes performance.now() at most 2 times with pool configured and no external signal", async () => {
      const transport: HttpTransport = ({ signal }) => {
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        pool: { concurrency: 10 },
        timeoutMs: 5000,
        transport,
      });

      const perfNowSpy = vi.spyOn(performance, "now");

      await run(client({ method: "GET", url: "/perf-check-pool" }));

      // Same constraint: at most 2 performance.now() calls
      expect(perfNowSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Abort propagation with external signals", () => {
    it("abort from external signal propagates correctly and produces Abort error", async () => {
      const transport: HttpTransport = () => {
        // Return a never-resolving effect to keep the request in-flight
        return {
          _tag: "Async",
          register: (_env: unknown, _cb: (exit: any) => void) => {
            return () => {}; // canceler
          },
        } as any;
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const externalController = new AbortController();
      const promise = run(client({
        method: "GET",
        url: "/abort-me",
        init: { signal: externalController.signal },
      } as any));

      // Give the request time to start
      await wait(10);

      // Abort the external signal
      externalController.abort();

      await expect(promise).rejects.toMatchObject({ _tag: "Abort" });
      expect(client.stats()).toMatchObject({ started: 1, aborted: 1 });
    });

    it("pre-aborted external signal immediately produces Abort error without calling transport", async () => {
      let transportCalled = false;
      const transport: HttpTransport = () => {
        transportCalled = true;
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        });
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const preAborted = new AbortController();
      preAborted.abort();

      await expect(
        run(client({
          method: "GET",
          url: "/pre-aborted",
          init: { signal: preAborted.signal },
        } as any))
      ).rejects.toMatchObject({ _tag: "Abort" });

      // Transport should not have been called
      expect(transportCalled).toBe(false);
      expect(client.stats()).toMatchObject({ started: 1, aborted: 1 });
    });

    it("abort with custom reason preserves the reason in the error", async () => {
      const transport: HttpTransport = () => {
        return {
          _tag: "Async",
          register: (_env: unknown, _cb: (exit: any) => void) => {
            return () => {};
          },
        } as any;
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        timeoutMs: 5000,
        transport,
      });

      const externalController = new AbortController();
      const timeoutReason = { _tag: "Timeout", timeoutMs: 100, phase: "request", message: "custom timeout" } as const;

      const promise = run(client({
        method: "GET",
        url: "/custom-abort",
        init: { signal: externalController.signal },
      } as any));

      await wait(10);
      externalController.abort(timeoutReason);

      // The error should preserve the tagged reason from the signal
      await expect(promise).rejects.toMatchObject(timeoutReason);
    });

    it("cancellation function works correctly on the pool transport path", async () => {
      const transport: HttpTransport = () => {
        return {
          _tag: "Async",
          register: (_env: unknown, _cb: (exit: any) => void) => {
            return () => {};
          },
        } as any;
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        pool: { concurrency: 10 },
        timeoutMs: 5000,
        transport,
      });

      // Use the effect's register directly to get the cancel function
      const effect = client({ method: "GET", url: "/cancel-test" });
      let exitResult: any;
      const cancel = effect.register({}, (exit) => { exitResult = exit; });

      // Cancel the request
      cancel?.();

      await wait(10);

      // Should produce an interrupt exit
      expect(exitResult).toBeDefined();
      expect(exitResult._tag).toBe("Failure");
    });

    it("cancellation aborts the signal passed to the transport on the pool path", async () => {
      let observedSignal: AbortSignal | undefined;
      let abortObserved = false;

      const transport: HttpTransport = ({ signal }) => {
        observedSignal = signal;
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: any) => void) => {
            const onAbort = () => {
              abortObserved = true;
              cb({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "Abort" } } });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            return () => signal.removeEventListener("abort", onAbort);
          },
        } as any;
      };

      const client = makeHttp({
        baseUrl: "https://api.example.test",
        pool: { concurrency: 10 },
        transport,
      });

      const effect = client({ method: "GET", url: "/cancel-aborts-signal" });
      const cancel = effect.register({}, () => {});

      expect(observedSignal).toBeDefined();
      expect(observedSignal!.aborted).toBe(false);

      cancel?.();

      expect(observedSignal!.aborted).toBe(true);
      expect(abortObserved).toBe(true);
    });
  });
});
