import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../client";
import { decorate } from "../client";
import { makeCompressionMiddleware } from "../compression";
import { withAuth } from "../lifecycle/middleware";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";

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
// 10.1 Test end-to-end gzip decompression with real zlib
// ---------------------------------------------------------------------------

describe("compression integration tests", () => {
  describe("10.1 end-to-end gzip decompression with real zlib", () => {
    it("decompresses a gzip-compressed response to the original text", async () => {
      const originalBody = "Hello, this is a gzip integration test with real zlib!";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/data" }));

      expect(result.bodyText).toBe(originalBody);
      expect(result.headers["Content-Encoding"]).toBeUndefined();
      expect(result.headers["Content-Length"]).toBe(String(Buffer.byteLength(originalBody, "utf-8")));
    });

    it("handles large gzip payloads correctly", async () => {
      const originalBody = "A".repeat(10_000) + " — end of large payload";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/large" }));

      expect(result.bodyText).toBe(originalBody);
    });

    it("handles unicode content in gzip", async () => {
      const originalBody = "Héllo wörld! 日本語テスト 🎉";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/unicode" }));

      expect(result.bodyText).toBe(originalBody);
    });
  });

  // ---------------------------------------------------------------------------
  // 10.2 Test end-to-end Brotli decompression with real zlib
  // ---------------------------------------------------------------------------

  describe("10.2 end-to-end Brotli decompression with real zlib", () => {
    it("decompresses a Brotli-compressed response to the original text", async () => {
      const originalBody = "Hello, this is a Brotli integration test with real zlib!";
      const compressed = zlib.brotliCompressSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "br",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/data" }));

      expect(result.bodyText).toBe(originalBody);
      expect(result.headers["Content-Encoding"]).toBeUndefined();
      expect(result.headers["Content-Length"]).toBe(String(Buffer.byteLength(originalBody, "utf-8")));
    });

    it("handles large Brotli payloads correctly", async () => {
      const originalBody = "B".repeat(10_000) + " — end of large Brotli payload";
      const compressed = zlib.brotliCompressSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "br",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/large-br" }));

      expect(result.bodyText).toBe(originalBody);
    });

    it("handles unicode content in Brotli", async () => {
      const originalBody = "Ünïcödé Brotli テスト 🚀✨";
      const compressed = zlib.brotliCompressSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "br",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/unicode-br" }));

      expect(result.bodyText).toBe(originalBody);
    });
  });

  // ---------------------------------------------------------------------------
  // 10.3 Test end-to-end deflate decompression with real zlib
  // ---------------------------------------------------------------------------

  describe("10.3 end-to-end deflate decompression with real zlib", () => {
    it("decompresses a deflate-compressed response to the original text", async () => {
      const originalBody = "Hello, this is a deflate integration test with real zlib!";
      const compressed = zlib.deflateSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "deflate",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/data" }));

      expect(result.bodyText).toBe(originalBody);
      expect(result.headers["Content-Encoding"]).toBeUndefined();
      expect(result.headers["Content-Length"]).toBe(String(Buffer.byteLength(originalBody, "utf-8")));
    });

    it("handles large deflate payloads correctly", async () => {
      const originalBody = "C".repeat(10_000) + " — end of large deflate payload";
      const compressed = zlib.deflateSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "deflate",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/large-deflate" }));

      expect(result.bodyText).toBe(originalBody);
    });

    it("handles unicode content in deflate", async () => {
      const originalBody = "Déflàte ünïcödé テスト 🎯";
      const compressed = zlib.deflateSync(Buffer.from(originalBody, "utf-8"));

      const { middleware } = makeCompressionMiddleware();
      const response = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "deflate",
        "Content-Length": String(compressed.byteLength),
      });
      const { next } = mockClient(response);

      const result = await run(middleware(next)({ method: "GET", url: "/unicode-deflate" }));

      expect(result.bodyText).toBe(originalBody);
    });
  });

  // ---------------------------------------------------------------------------
  // 10.4 Test composition with makeLifecycleClient and withAuth middleware
  // ---------------------------------------------------------------------------

  describe("10.4 composition with makeLifecycleClient and withAuth middleware", () => {
    it("compression middleware composes with withAuth via .with() on decorated client", async () => {
      const { middleware: compressionMiddleware } = makeCompressionMiddleware();

      const originalBody = "authenticated and compressed response";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      let capturedReq: HttpRequest | undefined;
      const mockFn: HttpClientFn = (req) => {
        capturedReq = req;
        return asyncSucceed(
          makeResponse(compressed.toString("latin1"), {
            "Content-Encoding": "gzip",
            "Content-Length": String(compressed.byteLength),
          }),
        );
      };

      const baseClient = decorate(mockFn);
      const composedClient = baseClient
        .with(compressionMiddleware)
        .with(withAuth(() => asyncSucceed("test-token-123")));

      const result = await run(composedClient({ method: "GET", url: "/secure" }));

      // Auth header was injected
      expect(capturedReq).toBeDefined();
      expect(capturedReq!.headers?.["Authorization"]).toBe("Bearer test-token-123");

      // Accept-Encoding was injected
      expect(capturedReq!.headers?.["Accept-Encoding"]).toBe("br, gzip, deflate");

      // Response was decompressed
      expect(result.bodyText).toBe(originalBody);
    });

    it("withAuth and compression work in any composition order", async () => {
      const { middleware: compressionMiddleware } = makeCompressionMiddleware();

      const originalBody = "order test response";
      const compressed = zlib.brotliCompressSync(Buffer.from(originalBody, "utf-8"));

      let capturedReq: HttpRequest | undefined;
      const mockFn: HttpClientFn = (req) => {
        capturedReq = req;
        return asyncSucceed(
          makeResponse(compressed.toString("latin1"), {
            "Content-Encoding": "br",
            "Content-Length": String(compressed.byteLength),
          }),
        );
      };

      const baseClient = decorate(mockFn);
      // Reverse order: auth first, then compression
      const composedClient = baseClient
        .with(withAuth(() => asyncSucceed("reverse-token")))
        .with(compressionMiddleware);

      const result = await run(composedClient({ method: "GET", url: "/reverse" }));

      // Both middleware applied
      expect(capturedReq!.headers?.["Authorization"]).toBe("Bearer reverse-token");
      expect(capturedReq!.headers?.["Accept-Encoding"]).toBe("br, gzip, deflate");
      expect(result.bodyText).toBe(originalBody);
    });

    it("compression stats still track correctly when composed with auth", async () => {
      const { middleware: compressionMiddleware, stats } = makeCompressionMiddleware();

      const originalBody = "stats tracking with auth";
      const compressed = zlib.gzipSync(Buffer.from(originalBody, "utf-8"));

      const mockFn: HttpClientFn = () => {
        return asyncSucceed(
          makeResponse(compressed.toString("latin1"), {
            "Content-Encoding": "gzip",
            "Content-Length": String(compressed.byteLength),
          }),
        );
      };

      const baseClient = decorate(mockFn);
      const composedClient = baseClient
        .with(compressionMiddleware)
        .with(withAuth(() => asyncSucceed("stats-token")));

      await run(composedClient({ method: "GET", url: "/stats" }));

      const s = stats();
      expect(s.decompressed.gzip).toBe(1);
      expect(s.compressedBytes).toBe(compressed.byteLength);
      expect(s.decompressedBytes).toBe(Buffer.byteLength(originalBody, "utf-8"));
    });
  });

  // ---------------------------------------------------------------------------
  // 10.5 Test stats accumulation across multiple sequential requests
  // ---------------------------------------------------------------------------

  describe("10.5 stats accumulation across multiple sequential requests", () => {
    it("accumulates stats across multiple gzip requests", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      const bodies = ["first request", "second request", "third request"];
      const compressedBodies = bodies.map((b) => zlib.gzipSync(Buffer.from(b, "utf-8")));

      for (const compressed of compressedBodies) {
        const response = makeResponse(compressed.toString("latin1"), {
          "Content-Encoding": "gzip",
          "Content-Length": String(compressed.byteLength),
        });
        const { next } = mockClient(response);
        await run(middleware(next)({ method: "GET", url: "/multi" }));
      }

      const s = stats();
      expect(s.decompressed.gzip).toBe(3);
      expect(s.decompressed.br).toBe(0);
      expect(s.decompressed.deflate).toBe(0);
    });

    it("accumulates stats across mixed encoding requests", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      const gzipBody = "gzip body";
      const brBody = "brotli body";
      const deflateBody = "deflate body";

      const gzipCompressed = zlib.gzipSync(Buffer.from(gzipBody, "utf-8"));
      const brCompressed = zlib.brotliCompressSync(Buffer.from(brBody, "utf-8"));
      const deflateCompressed = zlib.deflateSync(Buffer.from(deflateBody, "utf-8"));

      // Send gzip request
      const gzipResponse = makeResponse(gzipCompressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(gzipCompressed.byteLength),
      });
      const { next: next1 } = mockClient(gzipResponse);
      await run(middleware(next1)({ method: "GET", url: "/gzip" }));

      // Send brotli request
      const brResponse = makeResponse(brCompressed.toString("latin1"), {
        "Content-Encoding": "br",
        "Content-Length": String(brCompressed.byteLength),
      });
      const { next: next2 } = mockClient(brResponse);
      await run(middleware(next2)({ method: "GET", url: "/br" }));

      // Send deflate request
      const deflateResponse = makeResponse(deflateCompressed.toString("latin1"), {
        "Content-Encoding": "deflate",
        "Content-Length": String(deflateCompressed.byteLength),
      });
      const { next: next3 } = mockClient(deflateResponse);
      await run(middleware(next3)({ method: "GET", url: "/deflate" }));

      const s = stats();
      expect(s.decompressed.gzip).toBe(1);
      expect(s.decompressed.br).toBe(1);
      expect(s.decompressed.deflate).toBe(1);
    });

    it("accumulates compressedBytes and decompressedBytes across requests", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      const body1 = "short";
      const body2 = "a much longer body that should compress differently";

      const compressed1 = zlib.gzipSync(Buffer.from(body1, "utf-8"));
      const compressed2 = zlib.gzipSync(Buffer.from(body2, "utf-8"));

      const response1 = makeResponse(compressed1.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed1.byteLength),
      });
      const { next: next1 } = mockClient(response1);
      await run(middleware(next1)({ method: "GET", url: "/a" }));

      const response2 = makeResponse(compressed2.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed2.byteLength),
      });
      const { next: next2 } = mockClient(response2);
      await run(middleware(next2)({ method: "GET", url: "/b" }));

      const s = stats();
      expect(s.compressedBytes).toBe(compressed1.byteLength + compressed2.byteLength);
      expect(s.decompressedBytes).toBe(
        Buffer.byteLength(body1, "utf-8") + Buffer.byteLength(body2, "utf-8"),
      );
    });

    it("accumulates passthrough count for uncompressed responses", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      // One compressed, two uncompressed
      const compressedBody = "compressed";
      const compressed = zlib.gzipSync(Buffer.from(compressedBody, "utf-8"));

      const compressedResponse = makeResponse(compressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      const { next: next1 } = mockClient(compressedResponse);
      await run(middleware(next1)({ method: "GET", url: "/compressed" }));

      // Uncompressed response (no Content-Encoding)
      const plainResponse1 = makeResponse("plain text 1", {});
      const { next: next2 } = mockClient(plainResponse1);
      await run(middleware(next2)({ method: "GET", url: "/plain1" }));

      const plainResponse2 = makeResponse("plain text 2", {});
      const { next: next3 } = mockClient(plainResponse2);
      await run(middleware(next3)({ method: "GET", url: "/plain2" }));

      const s = stats();
      expect(s.decompressed.gzip).toBe(1);
      expect(s.passthroughCount).toBe(2);
    });

    it("accumulates error count for malformed compressed data", async () => {
      const { middleware, stats } = makeCompressionMiddleware();

      // One valid, one malformed
      const validBody = "valid";
      const validCompressed = zlib.gzipSync(Buffer.from(validBody, "utf-8"));

      const validResponse = makeResponse(validCompressed.toString("latin1"), {
        "Content-Encoding": "gzip",
        "Content-Length": String(validCompressed.byteLength),
      });
      const { next: next1 } = mockClient(validResponse);
      await run(middleware(next1)({ method: "GET", url: "/valid" }));

      // Malformed gzip data
      const malformedResponse = makeResponse("not-valid-gzip", {
        "Content-Encoding": "gzip",
        "Content-Length": "14",
      });
      const { next: next2 } = mockClient(malformedResponse);
      await run(middleware(next2)({ method: "GET", url: "/malformed" }));

      const s = stats();
      expect(s.decompressed.gzip).toBe(1);
      expect(s.errorCount).toBe(1);
    });
  });
});
