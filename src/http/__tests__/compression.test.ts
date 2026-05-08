import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import {
  makeCompressionMiddleware,
  makeRequestCompressionMiddleware,
  makeResponseCompressionMiddleware,
} from "../compression";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../client";

const rt = Runtime.make({});

const response = (bodyText: string, headers: Record<string, string> = {}): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers,
  bodyText,
  ms: 1,
});

describe("response compression middleware", () => {
  it("injects Accept-Encoding when missing", async () => {
    let captured: HttpRequest | undefined;
    const next: HttpClientFn = (req) => {
      captured = req;
      return asyncSucceed(response("ok"));
    };

    const { middleware } = makeResponseCompressionMiddleware({ encodings: ["gzip", "br"] });
    await rt.toPromise(middleware(next)({ method: "GET", url: "/data" }));

    expect(captured?.headers?.["Accept-Encoding"]).toBe("gzip, br");
  });

  it("decompresses gzip response bodies and clears content-encoding", async () => {
    const gzipped = zlib.gzipSync(Buffer.from("hello compression", "utf8"));
    const next: HttpClientFn = () =>
      asyncSucceed(response(gzipped.toString("latin1"), {
        "content-encoding": "gzip",
        "content-length": String(gzipped.byteLength),
      }));

    const result = makeCompressionMiddleware({ encodings: ["gzip"] });
    const res = await rt.toPromise(result.middleware(next)({ method: "GET", url: "/compressed" }));

    expect(res.bodyText).toBe("hello compression");
    expect(Object.keys(res.headers).some((key) => key.toLowerCase() === "content-encoding")).toBe(false);
    expect(res.headers["Content-Length"]).toBe(String(Buffer.byteLength("hello compression")));
    expect(result.stats()).toMatchObject({
      decompressed: { gzip: 1 },
      passthroughCount: 0,
      errorCount: 0,
    });
  });
});

describe("request compression middleware", () => {
  it("compresses eligible request bodies and sets content headers", async () => {
    let captured: HttpRequest | undefined;
    const next: HttpClientFn = (req) => {
      captured = req;
      return asyncSucceed(response("ok"));
    };

    const { middleware, stats } = makeRequestCompressionMiddleware({
      encoding: "gzip",
      minBytes: 1,
    });

    await rt.toPromise(middleware(next)({
      method: "POST",
      url: "/upload",
      headers: { "content-type": "text/plain" },
      body: "hello request compression",
    }));

    expect(captured?.headers?.["Content-Encoding"]).toBe("gzip");
    expect(captured?.headers?.["Content-Length"]).toBe(String((captured?.body as Uint8Array).byteLength));
    expect(zlib.gunzipSync(Buffer.from(captured?.body as Uint8Array)).toString("utf8")).toBe("hello request compression");
    expect(stats()).toMatchObject({
      compressedCount: 1,
      skippedCount: 0,
      errorCount: 0,
    });
  });

  it("skips requests below minBytes or with existing content-encoding", async () => {
    const bodies: unknown[] = [];
    const next: HttpClientFn = (req) => {
      bodies.push(req.body);
      return asyncSucceed(response("ok"));
    };

    const { middleware, stats } = makeRequestCompressionMiddleware({ minBytes: 100 });
    const client = middleware(next);

    await rt.toPromise(client({ method: "POST", url: "/small", body: "tiny" }));
    await rt.toPromise(client({
      method: "POST",
      url: "/already",
      headers: { "Content-Encoding": "gzip" },
      body: "this body is long enough to pass the byte threshold",
    }));

    expect(bodies).toEqual([
      "tiny",
      "this body is long enough to pass the byte threshold",
    ]);
    expect(stats()).toMatchObject({
      compressedCount: 0,
      skippedCount: 2,
    });
  });
});

