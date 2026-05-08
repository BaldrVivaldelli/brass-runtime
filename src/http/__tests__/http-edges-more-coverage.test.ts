import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import { Lens } from "../optics/lens";
import { atKey } from "../optics/record";
import { mergeHeaders, mergeHeadersUnder, removeHeader, setHeader, setHeaderIfMissing } from "../optics/request";
import { makeCompressionMiddleware, makeRequestCompressionMiddleware } from "../compression";
import { prewarmConnections, withConnectionPrewarming } from "../prewarm";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../client";

const rt = Runtime.make({});
const run = <A>(effect: any) => rt.toPromise(effect) as Promise<A>;

const response = (bodyText: string, headers: Record<string, string> = {}): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers,
  bodyText,
  ms: 1,
});

describe("compression middleware edge coverage", () => {
  it("passes through identity, unsupported, disabled, downstream failure, and observer stats snapshots", async () => {
    const unsupported = makeCompressionMiddleware();
    const unsupportedClient = unsupported.middleware(() => asyncSucceed(response("raw", { "Content-Encoding": "compress" })));
    await expect(run(unsupportedClient({ method: "GET", url: "/u" }))).resolves.toMatchObject({ bodyText: "raw" });
    expect(unsupported.stats()).toMatchObject({ unsupportedEncodingCount: 1, passthroughCount: 1 });

    const identity = makeCompressionMiddleware();
    await run(identity.middleware(() => asyncSucceed(response("id", { "Content-Encoding": "identity" })))({ method: "GET", url: "/id" }));
    expect(identity.stats().passthroughCount).toBe(1);

    const disabled = makeCompressionMiddleware({ encodings: ["br"] });
    const gzipped = zlib.gzipSync("gzip-only");
    const disabledRes = await run<HttpWireResponse>(
      disabled.middleware(() => asyncSucceed(response(gzipped.toString("latin1"), { "Content-Encoding": "gzip" })))({ method: "GET", url: "/disabled" }),
    );
    expect(disabledRes.headers["Content-Encoding"]).toBe("gzip");
    expect(disabled.stats().passthroughCount).toBe(1);

    const failed = makeCompressionMiddleware();
    await expect(
      run(failed.middleware(() => asyncFail({ _tag: "FetchError", message: "down" }))({ method: "GET", url: "/fail" })),
    ).rejects.toEqual({ _tag: "FetchError", message: "down" });
  });

  it("handles partial decompression and request compression variants", async () => {
    const partial = makeCompressionMiddleware({ encodings: ["gzip"] });
    const gzipped = zlib.gzipSync("partial");
    const partialRes = await run<HttpWireResponse>(
      partial.middleware(() => asyncSucceed(response(gzipped.toString("latin1"), { "Content-Encoding": "foo, gzip" })))({ method: "GET", url: "/partial" }),
    );
    expect(partialRes.headers["Content-Encoding"]).toBe("foo");
    expect(Buffer.from(partialRes.bodyText, "latin1").toString("utf8")).toBe("partial");

    const request = makeRequestCompressionMiddleware({ encoding: "br", minBytes: 0, methods: ["POST"] });
    let captured: HttpRequest | undefined;
    await run(request.middleware((req) => {
      captured = req;
      return asyncSucceed(response("ok"));
    })({ method: "POST", url: "/br", headers: { "Content-Length": "old" }, body: "brotli me" }));
    expect(captured?.headers?.["Content-Encoding"]).toBe("br");
    expect(zlib.brotliDecompressSync(Buffer.from(captured?.body as Uint8Array)).toString("utf8")).toBe("brotli me");

    const deflate = makeRequestCompressionMiddleware({ encoding: "deflate", minBytes: 0 });
    await run(deflate.middleware((req) => {
      expect(zlib.inflateSync(Buffer.from(req.body as Uint8Array)).toString("utf8")).toBe("deflate me");
      return asyncSucceed(response("ok"));
    })({ method: "PATCH", url: "/deflate", body: "deflate me" }));

    const erroring = makeRequestCompressionMiddleware({ encoding: "bad" as any, minBytes: 0 });
    await run(erroring.middleware((req) => {
      expect(req.body).toBe("unchanged");
      return asyncSucceed(response("ok"));
    })({ method: "POST", url: "/bad", body: "unchanged" }));
    expect(erroring.stats().errorCount).toBe(1);
  });

  it("fully decompresses chained headers, reports corrupt bodies, and skips request compression safely", async () => {
    const gzip = makeCompressionMiddleware({ encodings: ["gzip"] });
    const gzipped = zlib.gzipSync("plain text");
    const decompressed = await run<HttpWireResponse>(
      gzip.middleware(() => asyncSucceed(response(gzipped.toString("latin1"), {
        "content-encoding": "gzip",
        "Content-Encoding": "gzip",
        "Content-Length": String(gzipped.byteLength),
      })))({ method: "GET", url: "/gzip" }),
    );
    expect(decompressed.bodyText).toBe("plain text");
    expect(decompressed.headers["content-encoding"]).toBeUndefined();
    expect(decompressed.headers["Content-Encoding"]).toBeUndefined();
    expect(decompressed.headers["Content-Length"]).toBe(String(Buffer.byteLength("plain text")));
    expect(gzip.stats()).toMatchObject({ decompressed: { gzip: 1 }, errorCount: 0 });

    const corrupt = makeCompressionMiddleware();
    const corruptRes = await run<HttpWireResponse>(
      corrupt.middleware(() => asyncSucceed(response("not gzip", { "Content-Encoding": "gzip" })))({ method: "GET", url: "/corrupt" }),
    );
    expect(corruptRes.bodyText).toBe("not gzip");
    expect(corrupt.stats().errorCount).toBe(1);

    const request = makeRequestCompressionMiddleware({ minBytes: 10 });
    const seen: HttpRequest[] = [];
    const next: HttpClientFn = (req) => {
      seen.push(req);
      return asyncSucceed(response("ok"));
    };

    await run(request.middleware(next)({ method: "GET", url: "/method", body: "large enough body" }));
    await run(request.middleware(next)({ method: "POST", url: "/empty" }));
    await run(request.middleware(next)({ method: "POST", url: "/encoded", headers: { "content-encoding": "gzip" }, body: "large enough body" }));
    await run(request.middleware(next)({ method: "POST", url: "/small", body: "tiny" }));

    expect(seen.every((req) => !(req.body instanceof Uint8Array))).toBe(true);
    expect(request.stats()).toMatchObject({ skippedCount: 4, compressedCount: 0, errorCount: 0 });
  });
});

describe("prewarm edge coverage", () => {
  it("deduplicates targets, emits events, ignores observer failures, and supports failFast", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ status: 204 })
      .mockRejectedValueOnce(new Error("down"));
    const events: string[] = [];

    const result = await run(prewarmConnections({
      baseUrl: "https://example.test/api",
      urls: ["/a", "/a", "bad url"],
      origins: ["https://other.test"],
      path: "/warm",
      fetchImpl,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === "prewarm-success") throw new Error("observer ignored");
      },
    }));

    expect(result).toMatchObject({ attempted: 3, warmed: 1, failed: 2, skipped: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events).toContain("prewarm-start");
    expect(events).toContain("prewarm-failure");

    await expect(run(prewarmConnections({
      urls: ["https://fail.test"],
      fetchImpl: vi.fn().mockRejectedValue({ _tag: "Abort" }),
      failFast: true,
    }))).rejects.toEqual({ _tag: "Abort" });

    await expect(run(prewarmConnections({ fetchImpl: vi.fn() }))).resolves.toMatchObject({ attempted: 0 });
  });

  it("prewarming middleware respects predicates, invalid targets, once, and failFast", async () => {
    const next: HttpClientFn = vi.fn(() => asyncSucceed(response("next")));
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    const middleware = withConnectionPrewarming({ fetchImpl, once: true });
    const client = middleware(next);

    await run(client({ method: "GET", url: "https://example.test/a" }));
    await run(client({ method: "GET", url: "https://example.test/b" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await run(withConnectionPrewarming({ shouldPrewarm: () => false })(next)({ method: "GET", url: "https://skip.test" }));
    await run(withConnectionPrewarming({ target: () => "" })(next)({ method: "GET", url: "https://skip.test" }));
    await run(withConnectionPrewarming({ target: () => "not a url" })(next)({ method: "GET", url: "https://skip.test" }));

    await expect(run(withConnectionPrewarming({
      fetchImpl: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
      failFast: true,
    })(next)({ method: "GET", url: "https://abort.test" }))).rejects.toEqual({ _tag: "Abort" });
  });
});

describe("HTTP optics helpers", () => {
  it("gets, sets, composes, removes, and merges headers", () => {
    const req: HttpRequest = { method: "GET", url: "/x", headers: { A: "1" } };
    const a = atKey("A");
    expect(a.get(req.headers!)).toBe("1");
    expect(a.set(undefined)(req.headers!)).toEqual({});
    expect(a.set("2")({})).toEqual({ A: "2" });

    const composed = Lens.compose(atKey("A"), {
      get: (r: HttpRequest) => r.headers ?? {},
      set: (headers) => (r) => ({ ...r, headers }),
    });
    expect(composed.get(req)).toBe("1");
    expect(composed.set("3")(req).headers).toEqual({ A: "3" });

    expect(setHeader("B", "2")(req).headers).toEqual({ A: "1", B: "2" });
    expect(removeHeader("A")(req).headers).toEqual({});
    expect(mergeHeaders({ B: "2" })(req).headers).toEqual({ A: "1", B: "2" });
    expect(mergeHeadersUnder({ A: "0", B: "2" })(req).headers).toEqual({ A: "1", B: "2" });
    expect(setHeaderIfMissing("A", "x")(req).headers).toEqual({ A: "1" });
    expect(setHeaderIfMissing("B", "2")(req).headers).toEqual({ A: "1", B: "2" });
  });
});
