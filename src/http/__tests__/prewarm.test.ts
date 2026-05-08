import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import { prewarmConnections, withConnectionPrewarming } from "../prewarm";
import type { HttpClientFn, HttpWireResponse } from "../client";

const rt = Runtime.make({});

const response = (bodyText = "ok"): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText,
  ms: 1,
});

describe("prewarmConnections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prewarms configured URLs with HEAD by default", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await rt.toPromise(prewarmConnections({
      baseUrl: "https://api.example.com",
      urls: ["/health"],
      fetchImpl: fetchImpl as any,
    }));

    expect(result).toMatchObject({ attempted: 1, warmed: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.example.com/health");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "HEAD" });
  });

  it("records failures without failing the effect by default", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unavailable");
    });

    const result = await rt.toPromise(prewarmConnections({
      baseUrl: "https://api.example.com",
      fetchImpl: fetchImpl as any,
    }));

    expect(result).toMatchObject({ attempted: 1, warmed: 0, failed: 1 });
    expect(result.attempts[0]?.error).toMatchObject({ _tag: "FetchError" });
  });
});

describe("withConnectionPrewarming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prewarms an origin once before forwarding requests", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const calls: string[] = [];
    const next: HttpClientFn = (req) => {
      calls.push(req.url);
      return asyncSucceed(response(req.url));
    };

    const client = withConnectionPrewarming({
      baseUrl: "https://api.example.com",
      fetchImpl: fetchImpl as any,
    })(next);

    await expect(rt.toPromise(client({ method: "GET", url: "/one" }))).resolves.toMatchObject({ bodyText: "/one" });
    await expect(rt.toPromise(client({ method: "GET", url: "/two" }))).resolves.toMatchObject({ bodyText: "/two" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/one", "/two"]);
  });
});
