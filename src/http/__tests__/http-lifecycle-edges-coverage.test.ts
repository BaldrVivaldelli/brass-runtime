import { describe, expect, it } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { async, asyncSucceed, asyncSync } from "../../core/types/asyncEffect";
import { Cause } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { withDedup } from "../lifecycle/dedup";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import { withPriority } from "../lifecycle/priorityScheduler";
import { withCache } from "../lifecycle/responseCache";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const ok = (bodyText = "ok"): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText,
  ms: 1,
});

describe("lifecycle edge coverage", () => {
  it("maps an already-aborted external signal interrupt to Http Abort", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = makeLifecycleClient({}).with(() => (req) =>
      async((_env, cb) => {
        expect(((req.init as any).signal as AbortSignal).aborted).toBe(true);
        cb({ _tag: "Failure", cause: Cause.interrupt() });
      })
    );

    await expect(
      run(client({ method: "GET", url: "https://example.test", init: { signal: controller.signal } as any }))
    ).rejects.toEqual({ _tag: "Abort" });
  });

  it("turns thrown lifecycle middleware into FetchError", async () => {
    const client = makeLifecycleClient({}).with(() => () => {
      throw new Error("middleware boom");
    });

    await expect(run(client({ method: "GET", url: "https://example.test" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: middleware boom",
    });
  });

  it("maps dedup downstream defects to FetchError for initiator and waiters", async () => {
    const dedup = withDedup()(() =>
      asyncSync(() => {
        throw new Error("defect");
      }) as any
    );
    const request: HttpRequest = { method: "GET", url: "https://example.test/die" };

    await expect(run(dedup(request))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: defect",
    });
  });

  it("queued priority cancellation via returned canceler interrupts the caller", async () => {
    const downstream: HttpClientFn = () =>
      async((_env, _cb) => {
        // keep the concurrency slot occupied
        return () => undefined;
      });
    const priority = withPriority({ concurrency: 1 })(downstream);
    const first = priority({ method: "GET", url: "https://example.test/one" });
    const second = priority({ method: "GET", url: "https://example.test/two" });

    const firstCancel = first._tag === "Async" ? first.register({}, () => undefined) as (() => void) : undefined;
    const secondExit = await new Promise<any>((resolve) => {
      if (second._tag === "Async") {
        const cancel = second.register({}, resolve) as (() => void);
        cancel();
      }
    });

    firstCancel?.();
    expect(secondExit).toEqual({ _tag: "Failure", cause: Cause.interrupt() });
  });

  it("SWR cache respects uncacheable policy and non-safe methods", async () => {
    let calls = 0;
    const downstream: HttpClientFn = () => {
      calls++;
      return asyncSucceed(ok(`call:${calls}`));
    };

    const policyCache = withCache({
      staleWhileRevalidate: true,
      cachePolicy: () => ({ cacheable: false }),
    }).middleware(downstream);
    const getReq: HttpRequest = { method: "GET", url: "https://example.test/no-cache" };

    await expect(run(policyCache(getReq))).resolves.toMatchObject({ bodyText: "call:1" });
    await expect(run(policyCache(getReq))).resolves.toMatchObject({ bodyText: "call:2" });

    const methodCache = withCache({ staleWhileRevalidate: true }).middleware(downstream);
    const postReq: HttpRequest = { method: "POST", url: "https://example.test/post" };

    await expect(run(methodCache(postReq))).resolves.toMatchObject({ bodyText: "call:3" });
    await expect(run(methodCache(postReq))).resolves.toMatchObject({ bodyText: "call:4" });
  });
});
