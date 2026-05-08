import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync } from "../../core/types/asyncEffect";
import { Async } from "../../core/types/asyncEffect";
import { withRequestBatching } from "../batching";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";

const rt = Runtime.make({});
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const req = (url: string): HttpRequest => ({ method: "GET", url });
const response = (bodyText = "ok"): HttpWireResponse => ({ status: 200, statusText: "OK", headers: {}, bodyText, ms: 1 });

const config = (overrides: Partial<Parameters<typeof withRequestBatching>[0]> = {}) => ({
  key: () => "k",
  maxWaitMs: 1,
  maxBatchSize: 10,
  encode: (requests: readonly HttpRequest[]) => ({ method: "POST", url: "/batch", body: String(requests.length) }),
  decode: (res: HttpWireResponse, requests: readonly HttpRequest[]) => requests.map((request) => ({ ...res, bodyText: request.url })),
  ...overrides,
});

describe("request batching edge coverage", () => {
  it("bypasses batching when predicates or keys opt out or throw", async () => {
    const seen: string[] = [];
    const next: HttpClientFn = (request) => {
      seen.push(request.url);
      return asyncSucceed(response(request.url));
    };

    await expect(rt.toPromise(withRequestBatching(config({ shouldBatch: () => false }))(next)(req("/no")))).resolves.toMatchObject({ bodyText: "/no" });
    await expect(rt.toPromise(withRequestBatching(config({ key: () => "" }))(next)(req("/empty")))).resolves.toMatchObject({ bodyText: "/empty" });
    await expect(rt.toPromise(withRequestBatching(config({ key: () => { throw new Error("key"); } }))(next)(req("/throw")))).resolves.toMatchObject({ bodyText: "/throw" });

    expect(seen).toEqual(["/no", "/empty", "/throw"]);
  });

  it("normalizes encode, decode, downstream fail/die, and observer errors", async () => {
    const events: string[] = [];
    const observer = vi.fn((event: any) => {
      events.push(event.type);
      if (event.type === "batch-error") throw new Error("observer");
    });

    const okNext: HttpClientFn = () => asyncSucceed(response("batch"));

    await expect(
      rt.toPromise(withRequestBatching(config({
        encode: () => { throw new Error("encode failed"); },
        onEvent: observer,
      }))(okNext)(req("/encode"))),
    ).rejects.toMatchObject({ _tag: "FetchError", message: "encode failed" });

    await expect(
      rt.toPromise(withRequestBatching(config({
        decode: () => [],
        onEvent: observer,
      }))(okNext)(req("/decode"))),
    ).rejects.toMatchObject({ _tag: "FetchError", message: expect.stringContaining("decoder returned 0") });

    const timeout: HttpError = { _tag: "Timeout", ms: 1, message: "slow" } as any;
    await expect(
      rt.toPromise(withRequestBatching(config())(() => asyncFail(timeout))(req("/fail"))),
    ).rejects.toEqual(timeout);

    await expect(
      rt.toPromise(withRequestBatching(config())(() => asyncSync(() => { throw new Error("defect"); }) as any)(req("/die"))),
    ).rejects.toMatchObject({ _tag: "FetchError", message: "defect" });

    expect(events).toContain("batch-error");
  });

  it("runs FlatMap/Fold/Fork effects and cancels active batches when all entries cancel", async () => {
    const flatMapClient = withRequestBatching(config())(() =>
      asyncFlatMap(asyncSucceed(response("x")), (res) => asyncSucceed({ ...res, bodyText: "flat" }))
    );
    await expect(rt.toPromise(flatMapClient(req("/flat")))).resolves.toMatchObject({ bodyText: "/flat" });

    const foldClient = withRequestBatching(config())(() =>
      asyncFold(asyncFail<HttpError>({ _tag: "BadUrl", url: "bad", message: "bad" } as any), () => asyncSucceed(response("recovered")), asyncSucceed)
    );
    await expect(rt.toPromise(foldClient(req("/fold")))).resolves.toMatchObject({ bodyText: "/fold" });

    const forkClient = withRequestBatching(config())(() => ({ _tag: "Fork", effect: asyncSucceed(response("fork")) } as Async<any, any, any>));
    await expect(rt.toPromise(forkClient(req("/fork")))).resolves.toMatchObject({ bodyText: "/fork" });

    let cancelled = 0;
    const neverNext: HttpClientFn = () => async(() => () => { cancelled++; });
    const client = withRequestBatching(config({ maxBatchSize: 2, maxWaitMs: 1000 }))(neverNext);
    const f1 = rt.fork(client(req("/a")));
    const f2 = rt.fork(client(req("/b")));
    await wait();
    f1.interrupt();
    f2.interrupt();
    await wait();
    expect(cancelled).toBe(1);
  });

  it("uses the default key, normalized limits, async downstream success, and tagged encode errors", async () => {
    const events: string[] = [];
    const asyncNext: HttpClientFn = () => async((_env, cb) => {
      setTimeout(() => cb({ _tag: "Success", value: response("async-batch") }), 0);
      return () => undefined;
    });

    const client = withRequestBatching({
      maxBatchSize: 0,
      maxWaitMs: -10,
      encode: (requests) => ({ method: "POST", url: "/batch", body: String(requests.length) }),
      decode: (res, requests) => requests.map((request) => ({ ...res, bodyText: request.url })),
      onEvent: (event) => events.push(`${event.type}:${"reason" in event ? event.reason : ""}`),
    })(asyncNext);

    await expect(rt.toPromise(client(req("/default-key")))).resolves.toMatchObject({ bodyText: "/default-key" });
    expect(events).toContain("batch-flush:size");

    const badUrl: HttpError = { _tag: "BadUrl", message: "bad encode" } as any;
    const taggedEncode = withRequestBatching(config({ encode: () => { throw badUrl; } }))(() => asyncSucceed(response()));
    await expect(rt.toPromise(taggedEncode(req("/tagged")))).rejects.toEqual(badUrl);
  });

  it("maps interrupting downstream effects to Abort", async () => {
    const interrupted = withRequestBatching(config())(() =>
      async((_env, cb) => {
        cb({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      }),
    );
    await expect(rt.toPromise(interrupted(req("/interrupt")))).rejects.toEqual({ _tag: "Abort" });
  });

  it("cancels queued entries and leaves active downstream running while another entry still waits", async () => {
    const events: string[] = [];
    const queuedClient = withRequestBatching(config({
      maxBatchSize: 10,
      maxWaitMs: 1000,
      onEvent: (event) => events.push(`${event.type}:${"remaining" in event ? event.remaining : ""}`),
    }))(() => asyncSucceed(response("unused")));
    const queuedFiber = rt.fork(queuedClient(req("/queued")));
    await wait();
    queuedFiber.interrupt();
    await expect(new Promise((resolve) => queuedFiber.join(resolve))).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Interrupt" },
    });
    expect(events).toContain("batch-cancel:0");

    let callback: ((exit: any) => void) | undefined;
    let downstreamCancelled = 0;
    const activeClient = withRequestBatching(config({ maxBatchSize: 2, maxWaitMs: 1000 }))(() =>
      async((_env, cb) => {
        callback = cb;
        return () => { downstreamCancelled++; };
      }),
    );

    const first = rt.fork(activeClient(req("/first")));
    const second = rt.fork(activeClient(req("/second")));
    await wait();

    first.interrupt();
    await wait();
    expect(downstreamCancelled).toBe(0);

    callback?.({ _tag: "Success", value: response("batch") });

    await expect(new Promise((resolve) => first.join(resolve))).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Interrupt" },
    });
    await expect(new Promise((resolve) => second.join(resolve))).resolves.toMatchObject({
      _tag: "Success",
      value: expect.objectContaining({ bodyText: "/second" }),
    });
    expect(downstreamCancelled).toBe(0);
  });
});
