import { describe, expect, it } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { withRequestBatching } from "../batching";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";

const rt = Runtime.make({});
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const response = (bodyText: string): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  bodyText,
  ms: 1,
});

describe("withRequestBatching", () => {
  it("combines queued requests into one batch request and splits the response", async () => {
    const calls: HttpRequest[] = [];
    const next: HttpClientFn = (req) => {
      calls.push(req);
      const urls = JSON.parse(req.body as string) as string[];
      return asyncSucceed(response(JSON.stringify(urls.map((url) => `ok:${url}`))));
    };

    const client = withRequestBatching({
      key: () => "users",
      maxWaitMs: 5,
      maxBatchSize: 10,
      encode: (requests) => ({
        method: "POST",
        url: "/batch",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requests.map((req) => req.url)),
      }),
      decode: (res) => {
        const bodies = JSON.parse(res.bodyText) as string[];
        return bodies.map((bodyText) => ({ ...res, bodyText }));
      },
    })(next);

    const p1 = rt.toPromise(client({ method: "GET", url: "/users/1" }));
    const p2 = rt.toPromise(client({ method: "GET", url: "/users/2" }));

    await expect(Promise.all([p1, p2])).resolves.toMatchObject([
      { bodyText: "ok:/users/1" },
      { bodyText: "ok:/users/2" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/batch" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual(["/users/1", "/users/2"]);
  });

  it("flushes immediately when maxBatchSize is reached", async () => {
    const calls: HttpRequest[] = [];
    const events: string[] = [];
    const next: HttpClientFn = (req) => {
      calls.push(req);
      return asyncSucceed(response(JSON.stringify(["first", "second"])));
    };

    const client = withRequestBatching({
      key: () => "size",
      maxWaitMs: 1000,
      maxBatchSize: 2,
      encode: (requests) => ({ method: "POST", url: "/batch", body: String(requests.length) }),
      decode: (res) => (JSON.parse(res.bodyText) as string[]).map((bodyText) => ({ ...res, bodyText })),
      onEvent: (event) => {
        if (event.type === "batch-flush") events.push(event.reason);
      },
    })(next);

    const p1 = rt.toPromise(client({ method: "GET", url: "/a" }));
    const p2 = rt.toPromise(client({ method: "GET", url: "/b" }));

    await expect(Promise.all([p1, p2])).resolves.toMatchObject([
      { bodyText: "first" },
      { bodyText: "second" },
    ]);

    expect(calls).toHaveLength(1);
    expect(events).toContain("size");
  });

  it("removes a queued request when its fiber is interrupted before flush", async () => {
    const calls: HttpRequest[] = [];
    const next: HttpClientFn = (req) => {
      calls.push(req);
      return asyncSucceed(response("late"));
    };

    const client = withRequestBatching({
      key: () => "cancel",
      maxWaitMs: 25,
      encode: (requests) => ({ method: "POST", url: "/batch", body: String(requests.length) }),
      decode: (res) => [res],
    })(next);

    const fiber = rt.fork(client({ method: "GET", url: "/cancelled" }));
    await wait(0);
    fiber.interrupt();

    const exit = await new Promise<Exit<HttpError, HttpWireResponse>>((resolve) => fiber.join(resolve));
    await wait(30);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(exit.cause._tag).toBe("Interrupt");
    expect(calls).toHaveLength(0);
  });
});
