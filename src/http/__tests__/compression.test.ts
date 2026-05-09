import { describe, it, expect, vi } from "vitest";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../client";
import { decorate } from "../client";
import {
  makeCompressionMiddleware,
  SUPPORTED_ENCODINGS,
} from "../compression";
import { isNodeEnvironment } from "../compression/environment";
import { createNoopDecompressor } from "../compression/decompressor.noop";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const rt = Runtime.make({});
const run = <A>(eff: Async<unknown, any, A>): Promise<A> => rt.toPromise(eff);

function mockClient(response: HttpWireResponse): {
  next: HttpClientFn;
  captured: () => HttpRequest | undefined;
} {
  let capturedReq: HttpRequest | undefined;
  const next: HttpClientFn = (req) => {
    capturedReq = req;
    return asyncSucceed(response);
  };
  return { next, captured: () => capturedReq };
}

function makeResponse(
  bodyText: string,
  headers: Record<string, string> = {},
): HttpWireResponse {
  return {
    status: 200,
    statusText: "OK",
    headers,
    bodyText,
    ms: 1,
  };
}

// ---------------------------------------------------------------------------
// 9.1 Test default encoding order is "br, gzip, deflate"
// ---------------------------------------------------------------------------

describe("compression middleware unit tests", () => {
  describe("9.1 default encoding order", () => {
    it("SUPPORTED_ENCODINGS constant is br, gzip, deflate in that order", () => {
      expect(SUPPORTED_ENCODINGS).toEqual(["br", "gzip", "deflate"]);
    });

    it("middleware injects Accept-Encoding as 'br, gzip, deflate' by default", async () => {
      const { middleware } = makeCompressionMiddleware();
      const { next, captured } = mockClient(makeResponse("ok"));

      await run(middleware(next)({ method: "GET", url: "/test" }));

      const sentReq = captured()!;
      expect(sentReq.headers?.["Accept-Encoding"]).toBe("br, gzip, deflate");
    });
  });

  // ---------------------------------------------------------------------------
  // 9.2 Test environment detection identifies Node.js correctly
  // ---------------------------------------------------------------------------

  describe("9.2 environment detection - Node.js", () => {
    it("isNodeEnvironment() returns true in Node.js", () => {
      // We are running in Node.js, so this should be true
      expect(isNodeEnvironment()).toBe(true);
    });

    it("process.versions.node is defined in Node.js", () => {
      expect(process.versions.node).toBeDefined();
      expect(typeof process.versions.node).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // 9.3 Test environment detection identifies browser (mocked) correctly
  // ---------------------------------------------------------------------------

  describe("9.3 environment detection - browser (mocked)", () => {
    it("isNodeEnvironment() returns false when process.versions is undefined", () => {
      const originalVersions = process.versions;
      try {
        // Simulate browser: process exists but versions is null
        Object.defineProperty(process, "versions", {
          value: null,
          writable: true,
          configurable: true,
        });
        expect(isNodeEnvironment()).toBe(false);
      } finally {
        Object.defineProperty(process, "versions", {
          value: originalVersions,
          writable: true,
          configurable: true,
        });
      }
    });

    it("isNodeEnvironment() returns false when process.versions.node is null", () => {
      const originalVersions = process.versions;
      try {
        Object.defineProperty(process, "versions", {
          value: { ...originalVersions, node: null },
          writable: true,
          configurable: true,
        });
        expect(isNodeEnvironment()).toBe(false);
      } finally {
        Object.defineProperty(process, "versions", {
          value: originalVersions,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 9.4 Test stats() returns a frozen object
  // ---------------------------------------------------------------------------

  describe("9.4 stats() returns a frozen object", () => {
    it("stats() snapshot is frozen at the top level", () => {
      const { stats } = makeCompressionMiddleware();
      const s = stats();
      expect(Object.isFrozen(s)).toBe(true);
    });

    it("stats().decompressed is frozen", () => {
      const { stats } = makeCompressionMiddleware();
      const s = stats();
      expect(Object.isFrozen(s.decompressed)).toBe(true);
    });

    it("attempting to mutate stats throws in strict mode", () => {
      const { stats } = makeCompressionMiddleware();
      const s = stats();
      expect(() => {
        (s as any).passthroughCount = 999;
      }).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 9.5 Test middleware composition with .with() on HttpClient
  // ---------------------------------------------------------------------------

  describe("9.5 middleware composition with .with()", () => {
    it("compression middleware composes via .with() on HttpClient", async () => {
      const { middleware } = makeCompressionMiddleware();

      // Create a base HttpClient using decorate
      const mockFn: HttpClientFn = (req) => {
        return asyncSucceed(makeResponse("hello", {}));
      };
      const baseClient = decorate(mockFn);

      // Compose with compression middleware
      const composedClient = baseClient.with(middleware);

      // The composed client should work and inject Accept-Encoding
      const result = await run(composedClient({ method: "GET", url: "/api" }));
      expect(result.bodyText).toBe("hello");
    });

    it("composed client injects Accept-Encoding header", async () => {
      const { middleware } = makeCompressionMiddleware();

      let capturedReq: HttpRequest | undefined;
      const mockFn: HttpClientFn = (req) => {
        capturedReq = req;
        return asyncSucceed(makeResponse("ok", {}));
      };
      const baseClient = decorate(mockFn);
      const composedClient = baseClient.with(middleware);

      await run(composedClient({ method: "GET", url: "/api" }));

      expect(capturedReq).toBeDefined();
      expect(capturedReq!.headers?.["Accept-Encoding"]).toBe("br, gzip, deflate");
    });

    it("composed client decompresses gzip responses", async () => {
      const { middleware } = makeCompressionMiddleware();

      const originalBody = "Hello, compressed world!";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      const mockFn: HttpClientFn = (_req) => {
        return asyncSucceed(
          makeResponse(compressed.toString("latin1"), {
            "Content-Encoding": "gzip",
            "Content-Length": String(compressed.byteLength),
          }),
        );
      };
      const baseClient = decorate(mockFn);
      const composedClient = baseClient.with(middleware);

      const result = await run(composedClient({ method: "GET", url: "/api" }));
      expect(result.bodyText).toBe(originalBody);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.6 Test multi-encoding with unsupported step stops at correct point
  // ---------------------------------------------------------------------------

  describe("9.6 multi-encoding with unsupported step", () => {
    it("stops decompression at unsupported encoding in multi-encoding chain", async () => {
      const { middleware } = makeCompressionMiddleware();

      // Simulate: body was first gzipped, then "zstd" was applied.
      // Content-Encoding: "gzip, zstd" means gzip first, zstd last.
      // Middleware decompresses in reverse: tries zstd first (unsupported), stops.
      const originalBody = "test data";
      const gzipped = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));
      // The wire body is the gzipped data (pretend zstd was applied on top but we just use raw)
      const bodyText = gzipped.toString("latin1");

      const response = makeResponse(bodyText, {
        "Content-Encoding": "gzip, zstd",
        "Content-Length": String(gzipped.byteLength),
      });

      const { next } = mockClient(response);
      const result = await run(middleware(next)({ method: "GET", url: "/test" }));

      // Since zstd is unsupported and is the outermost encoding (decompressed first),
      // the middleware should stop and return the body unchanged
      expect(result.bodyText).toBe(bodyText);
    });

    it("partially decompresses when unsupported encoding is inner", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      // Simulate: body was first "zstd" compressed, then gzipped.
      // Content-Encoding: "zstd, gzip" means zstd first, gzip last.
      // Middleware decompresses in reverse: gzip first (supported), then zstd (unsupported, stops).
      const innerData = Buffer.from("inner-zstd-compressed-data", "latin1");
      const gzipped = zlib.gzipSync(innerData);
      const bodyText = gzipped.toString("latin1");

      const response = makeResponse(bodyText, {
        "Content-Encoding": "zstd, gzip",
        "Content-Length": String(gzipped.byteLength),
      });

      const { next } = mockClient(response);
      const result = await run(middleware(next)({ method: "GET", url: "/test" }));

      // Gzip was decompressed successfully, then zstd is unsupported so it stops.
      // The result should have the inner data (after gzip decompression) with
      // Content-Encoding showing the remaining "zstd".
      expect(result.headers["Content-Encoding"]).toBe("zstd");
      expect(result.bodyText).toBe(innerData.toString("latin1"));
      expect(stats().unsupportedEncodingCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.7 Test fallback behavior when environment is ambiguous
  // ---------------------------------------------------------------------------

  describe("9.7 fallback behavior - decompression fails gracefully", () => {
    it("returns original response when decompression fails on malformed data", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      // Malformed gzip data
      const garbage = Buffer.from("this-is-not-valid-gzip-data");
      const bodyText = garbage.toString("latin1");
      const headers = {
        "Content-Encoding": "gzip",
        "Content-Length": String(garbage.byteLength),
      };

      const response = makeResponse(bodyText, headers);
      const { next } = mockClient(response);

      // Should not throw — returns original response
      const result = await run(middleware(next)({ method: "GET", url: "/test" }));

      expect(result.bodyText).toBe(bodyText);
      expect(result.headers).toEqual(headers);
      expect(stats().errorCount).toBe(1);
    });

    it("noop decompressor returns data unchanged for any encoding", () => {
      const noop = createNoopDecompressor();
      expect(noop.isPassthrough).toBe(true);

      const input = Buffer.from("arbitrary data");
      const result = noop.decompress(input, "gzip");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Buffer.compare(result.data, input)).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 9.8 Test Content-Encoding: identity is treated as no encoding
  // ---------------------------------------------------------------------------

  describe("9.8 Content-Encoding: identity treated as no encoding", () => {
    it("identity encoding passes body through unchanged", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      const body = "plain text body, not compressed";
      const response = makeResponse(body, {
        "Content-Encoding": "identity",
      });

      const { next } = mockClient(response);
      const result = await run(middleware(next)({ method: "GET", url: "/test" }));

      expect(result.bodyText).toBe(body);
      expect(stats().passthroughCount).toBe(1);
    });

    it("identity encoding does not increment decompressed counters", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      const body = "some response body";
      const response = makeResponse(body, {
        "Content-Encoding": "identity",
      });

      const { next } = mockClient(response);
      await run(middleware(next)({ method: "GET", url: "/test" }));

      const s = stats();
      expect(s.decompressed.gzip).toBe(0);
      expect(s.decompressed.br).toBe(0);
      expect(s.decompressed.deflate).toBe(0);
      expect(s.errorCount).toBe(0);
    });

    it("identity encoding (case-insensitive) passes through", async () => {
      const { middleware } = makeCompressionMiddleware();

      const body = "case insensitive test";
      const response = makeResponse(body, {
        "Content-Encoding": "Identity",
      });

      const { next } = mockClient(response);
      const result = await run(middleware(next)({ method: "GET", url: "/test" }));

      expect(result.bodyText).toBe(body);
    });
  });
});
