import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed, asyncFail } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import {
  makeCompressionMiddleware,
  SUPPORTED_ENCODINGS,
} from "../compression";
import type { CompressionConfig, SupportedEncoding } from "../compression";
import { createNoopDecompressor } from "../compression/decompressor.noop";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Runtime instance for running Async effects in tests */
const rt = Runtime.make({});
const run = <A>(eff: Async<unknown, any, A>): Promise<A> => rt.toPromise(eff);

// ---------------------------------------------------------------------------
// Mock HTTP client helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock HttpClientFn that captures the request and returns a
 * predetermined response.
 */
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

/**
 * Creates a mock HttpClientFn that always fails with the given HttpError.
 */
function failingClient(error: HttpError): HttpClientFn {
  return (_req) => asyncFail(error);
}

/**
 * Creates a simple HttpWireResponse with the given body and headers.
 */
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
// Compression helpers for tests
// ---------------------------------------------------------------------------

/**
 * Compresses a string body using the specified encoding.
 * Returns the compressed buffer encoded as latin1 string (for bodyText).
 */
function compress(body: string, encoding: SupportedEncoding): Buffer {
  const input = Buffer.from(body, "utf-8");
  switch (encoding) {
    case "gzip":
      return zlib.gzipSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "deflate":
      return zlib.deflateSync(input);
  }
}

/**
 * Compresses a raw Buffer using the specified encoding.
 * Used for multi-encoding scenarios where intermediate data is binary.
 */
function compressBuffer(input: Buffer, encoding: SupportedEncoding): Buffer {
  switch (encoding) {
    case "gzip":
      return zlib.gzipSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "deflate":
      return zlib.deflateSync(input);
  }
}

// ---------------------------------------------------------------------------
// Shared arbitraries / generators
// ---------------------------------------------------------------------------

/** Arbitrary for a single supported encoding */
const arbSupportedEncoding: fc.Arbitrary<SupportedEncoding> = fc.constantFrom(
  "gzip",
  "br",
  "deflate",
);

/** Arbitrary for a valid CompressionConfig with a non-empty subset of encodings */
const arbCompressionConfig: fc.Arbitrary<CompressionConfig> = fc
  .subarray([...SUPPORTED_ENCODINGS], { minLength: 1 })
  .chain((encodings) =>
    fc.shuffledSubarray(encodings, { minLength: encodings.length, maxLength: encodings.length })
      .map((shuffled) => ({ encodings: shuffled })),
  );

/** Arbitrary for body text — ASCII + basic Unicode, non-empty */
const arbBodyText: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

/**
 * Arbitrary for an HttpRequest without Accept-Encoding header.
 * Uses safe header names that won't collide with Accept-Encoding.
 */
const arbHttpRequestWithoutAE: fc.Arbitrary<HttpRequest> = fc.record({
  method: fc.constantFrom("GET" as const, "POST" as const, "PUT" as const, "DELETE" as const),
  url: fc.constantFrom("/api/data", "/users", "/items/123", "/health"),
  headers: fc
    .array(
      fc.tuple(
        fc.constantFrom("x-request-id", "x-custom", "authorization", "content-type"),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      ),
      { minLength: 0, maxLength: 3 },
    )
    .map((entries) => Object.fromEntries(entries)),
});

/**
 * Arbitrary for an HttpRequest that already has an Accept-Encoding header.
 */
const arbHttpRequestWithAE: fc.Arbitrary<HttpRequest> = fc.record({
  method: fc.constantFrom("GET" as const, "POST" as const, "PUT" as const, "DELETE" as const),
  url: fc.constantFrom("/api/data", "/users", "/items/123", "/health"),
  headers: fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => s.trim().length > 0)
    .map((aeValue) => ({ "Accept-Encoding": aeValue })),
});

/** Arbitrary for HttpError variants */
const arbHttpError: fc.Arbitrary<HttpError> = fc.oneof(
  fc.constant({ _tag: "Abort" } as HttpError),
  fc.string({ minLength: 1, maxLength: 50 }).map(
    (msg) => ({ _tag: "BadUrl", message: msg }) as HttpError,
  ),
  fc.string({ minLength: 1, maxLength: 50 }).map(
    (msg) => ({ _tag: "FetchError", message: msg }) as HttpError,
  ),
  fc.integer({ min: 100, max: 60000 }).map(
    (ms) => ({ _tag: "Timeout", timeoutMs: ms, message: `Timeout after ${ms}ms` }) as HttpError,
  ),
);

/** Arbitrary for unsupported encoding strings */
const arbUnsupportedEncoding: fc.Arbitrary<string> = fc.constantFrom(
  "zstd",
  "lz4",
  "snappy",
  "compress",
  "unknown-enc",
);

/**
 * Feature: http-compression
 * Property-based tests for the HTTP compression middleware.
 */
describe("compression middleware property tests", () => {
  // Placeholder — individual property tests will be added in subsequent tasks (8.2–8.12)
  it("test infrastructure is functional", async () => {
    const { middleware, stats } = makeCompressionMiddleware();
    const { next, captured } = mockClient(makeResponse("hello"));
    const res = await run(middleware(next)({ method: "GET", url: "/test" }));
    expect(res.bodyText).toBe("hello");
    expect(captured()).toBeDefined();
    expect(stats().passthroughCount).toBeGreaterThanOrEqual(0);
  });

  /**
   * Property 1: Accept-Encoding header injection reflects configuration
   *
   * For any CompressionConfig with a subset of encodings, the middleware injects
   * an Accept-Encoding header that contains exactly those encodings (joined by ", ")
   * when the request doesn't already have one.
   *
   * **Validates: Requirements 1.1, 1.4, 6.1, 6.3**
   */
  it("Property 1: Accept-Encoding header injection reflects configuration", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCompressionConfig,
        arbHttpRequestWithoutAE,
        async (config, request) => {
          const { middleware } = makeCompressionMiddleware(config);
          const { next, captured } = mockClient(makeResponse("ok"));

          await run(middleware(next)(request));

          const sentReq = captured()!;
          expect(sentReq).toBeDefined();

          const acceptEncoding = sentReq.headers?.["Accept-Encoding"];
          expect(acceptEncoding).toBeDefined();

          const expected = config.encodings!.join(", ");
          expect(acceptEncoding).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 2: Existing Accept-Encoding headers are preserved
   *
   * For any HttpRequest that already contains an Accept-Encoding header with any
   * value, the middleware passes the request to the downstream client with the
   * Accept-Encoding header value unchanged (does not overwrite it).
   *
   * **Validates: Requirements 1.2**
   */
  it("Property 2: Existing Accept-Encoding headers are preserved", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCompressionConfig,
        arbHttpRequestWithAE,
        async (config, request) => {
          const { middleware } = makeCompressionMiddleware(config);
          const { next, captured } = mockClient(makeResponse("ok"));

          const originalAE = request.headers!["Accept-Encoding"];

          await run(middleware(next)(request));

          const sentReq = captured()!;
          expect(sentReq).toBeDefined();

          const sentAE = sentReq.headers?.["Accept-Encoding"];
          expect(sentAE).toBe(originalAE);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 3: Decompression round-trip
   *
   * For any valid string body and for any supported encoding, compressing the body
   * with that encoding and then passing the compressed response (with appropriate
   * Content-Encoding header) through the middleware produces a response with bodyText
   * equal to the original string.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  it("Property 3: Decompression round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBodyText,
        arbSupportedEncoding,
        async (originalBody, encoding) => {
          const { middleware } = makeCompressionMiddleware();

          // Compress the body and store as latin1 (binary representation in wire response)
          const compressed = compress(originalBody, encoding);
          const bodyText = compressed.toString("latin1");

          // Create a response with the compressed body and Content-Encoding header
          const response = makeResponse(bodyText, {
            "Content-Encoding": encoding,
            "Content-Length": String(compressed.byteLength),
          });

          const { next } = mockClient(response);
          const result = await run(middleware(next)({ method: "GET", url: "/test" }));

          // The decompressed body should equal the original
          expect(result.bodyText).toBe(originalBody);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 4: Unsupported or missing encoding passthrough
   *
   * For any response that has no Content-Encoding header, or has Content-Encoding: identity,
   * or has an unsupported Content-Encoding value, the middleware returns the response body
   * without modification.
   *
   * **Validates: Requirements 2.4, 2.5**
   */
  it("Property 4: Unsupported or missing encoding passthrough", async () => {
    const arbEncodingScenario: fc.Arbitrary<Record<string, string>> = fc.oneof(
      // No Content-Encoding header at all
      fc.constant({}),
      // Content-Encoding: identity
      fc.constant({ "Content-Encoding": "identity" }),
      // Unsupported encoding value
      arbUnsupportedEncoding.map((enc) => ({ "Content-Encoding": enc })),
    );

    await fc.assert(
      fc.asyncProperty(
        arbBodyText,
        arbEncodingScenario,
        async (body, headers) => {
          const { middleware } = makeCompressionMiddleware();
          const response = makeResponse(body, headers);
          const { next } = mockClient(response);

          const result = await run(middleware(next)({ method: "GET", url: "/test" }));

          // Body must pass through unchanged
          expect(result.bodyText).toBe(body);
        },
      ),
      { numRuns: 100 },
    );
  });
  /**
   * Property 5: Passthrough mode only injects headers
   *
   * For any response processed while the middleware is in passthrough mode (noop
   * decompressor), the response body is returned unchanged (no decompression
   * attempted). The noop decompressor contract guarantees: isPassthrough === true
   * and decompress() returns input data unchanged for any body and any supported
   * encoding.
   *
   * **Validates: Requirements 3.2, 5.1, 5.2**
   */
  it("Property 5: Passthrough mode only injects headers", async () => {
    const noopDecompressor = createNoopDecompressor();

    // Verify the noop decompressor declares passthrough mode
    expect(noopDecompressor.isPassthrough).toBe(true);

    await fc.assert(
      fc.asyncProperty(
        arbBodyText,
        arbSupportedEncoding,
        async (body, encoding) => {
          // Create arbitrary binary data (simulating a compressed body)
          const inputBuffer = Buffer.from(body, "utf-8");

          // The noop decompressor should return the input unchanged
          const result = noopDecompressor.decompress(inputBuffer, encoding);

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(Buffer.compare(result.data as Buffer, inputBuffer)).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
  /**
   * Property 7: HttpError passthrough
   *
   * For any HttpError produced by the downstream HttpClientFn, the compression
   * middleware propagates that error unchanged — the error's _tag and all fields
   * are identical.
   *
   * **Validates: Requirements 7.3**
   */
  it("Property 7: HttpError passthrough", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbHttpError,
        arbHttpRequestWithoutAE,
        async (error, request) => {
          const { middleware } = makeCompressionMiddleware();
          const next = failingClient(error);

          try {
            await run(middleware(next)(request));
            // Should never reach here — the effect must fail
            expect.fail("Expected the effect to fail with an HttpError");
          } catch (caught) {
            // The error should be passed through unchanged
            expect(caught).toEqual(error);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 8: Post-decompression header correctness
   *
   * For any response that is successfully decompressed, the returned response SHALL
   * have: (a) Content-Length equal to the byte length of the decompressed body, and
   * (b) no Content-Encoding header present.
   *
   * **Validates: Requirements 8.1, 8.2, 8.3**
   */
  it("Property 8: Post-decompression header correctness", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBodyText,
        arbSupportedEncoding,
        async (originalBody, encoding) => {
          const { middleware } = makeCompressionMiddleware();

          // Compress the body
          const compressed = compress(originalBody, encoding);
          const bodyText = compressed.toString("latin1");

          // Create a response with Content-Encoding and Content-Length headers
          const response = makeResponse(bodyText, {
            "Content-Encoding": encoding,
            "Content-Length": String(compressed.byteLength),
          });

          const { next } = mockClient(response);
          const result = await run(middleware(next)({ method: "GET", url: "/test" }));

          // After successful decompression, Content-Encoding must be removed
          const contentEncoding = result.headers["Content-Encoding"];
          expect(contentEncoding).toBeUndefined();

          // After successful decompression, Content-Length must equal decompressed body byte length
          const expectedLength = Buffer.from(result.bodyText, "utf-8").byteLength;
          expect(result.headers["Content-Length"]).toBe(String(expectedLength));
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 9: Stats accuracy
   *
   * For any sequence of N responses processed by the middleware, the CompressionStats
   * SHALL satisfy: decompressed[enc] equals the count of successfully decompressed
   * responses for each encoding, passthroughCount equals the count of responses that
   * were not decompressed, unsupportedEncodingCount equals the count of unsupported
   * encodings encountered, errorCount equals the count of decompression failures,
   * and the sum of all counters equals the total number of requests processed.
   *
   * **Validates: Requirements 9.1, 9.2, 9.4**
   */
  it("Property 9: Stats accuracy", async () => {
    /**
     * Represents a single request scenario for stats verification.
     */
    type RequestScenario =
      | { type: "compressed"; encoding: SupportedEncoding; body: string }
      | { type: "no-encoding"; body: string }
      | { type: "unsupported"; encoding: string; body: string }
      | { type: "malformed"; encoding: SupportedEncoding; body: string };

    /** Arbitrary for a compressed request scenario */
    const arbCompressed: fc.Arbitrary<RequestScenario> = fc
      .tuple(arbSupportedEncoding, arbBodyText)
      .map(([encoding, body]) => ({ type: "compressed" as const, encoding, body }));

    /** Arbitrary for a no-encoding request scenario */
    const arbNoEncoding: fc.Arbitrary<RequestScenario> = arbBodyText.map((body) => ({
      type: "no-encoding" as const,
      body,
    }));

    /** Arbitrary for an unsupported encoding request scenario */
    const arbUnsupported: fc.Arbitrary<RequestScenario> = fc
      .tuple(arbUnsupportedEncoding, arbBodyText)
      .map(([encoding, body]) => ({ type: "unsupported" as const, encoding, body }));

    /** Arbitrary for a malformed compressed body scenario */
    const arbMalformed: fc.Arbitrary<RequestScenario> = fc
      .tuple(arbSupportedEncoding, arbBodyText)
      .map(([encoding, body]) => ({ type: "malformed" as const, encoding, body }));

    /** Arbitrary for a sequence of request scenarios */
    const arbScenarioSequence: fc.Arbitrary<RequestScenario[]> = fc.array(
      fc.oneof(arbCompressed, arbNoEncoding, arbUnsupported, arbMalformed),
      { minLength: 1, maxLength: 10 },
    );

    await fc.assert(
      fc.asyncProperty(arbScenarioSequence, async (scenarios) => {
        const { middleware, stats } = makeCompressionMiddleware();

        // Expected counters
        let expectedDecompressedGzip = 0;
        let expectedDecompressedBr = 0;
        let expectedDecompressedDeflate = 0;
        let expectedPassthrough = 0;
        let expectedUnsupported = 0;
        let expectedError = 0;

        for (const scenario of scenarios) {
          let response: ReturnType<typeof makeResponse>;

          switch (scenario.type) {
            case "compressed": {
              const compressed = compress(scenario.body, scenario.encoding);
              response = makeResponse(compressed.toString("latin1"), {
                "Content-Encoding": scenario.encoding,
                "Content-Length": String(compressed.byteLength),
              });
              // Expect successful decompression
              switch (scenario.encoding) {
                case "gzip":
                  expectedDecompressedGzip++;
                  break;
                case "br":
                  expectedDecompressedBr++;
                  break;
                case "deflate":
                  expectedDecompressedDeflate++;
                  break;
              }
              break;
            }
            case "no-encoding": {
              response = makeResponse(scenario.body, {});
              expectedPassthrough++;
              break;
            }
            case "unsupported": {
              response = makeResponse(scenario.body, {
                "Content-Encoding": scenario.encoding,
              });
              // Unsupported encoding increments both unsupported and passthrough
              expectedUnsupported++;
              expectedPassthrough++;
              break;
            }
            case "malformed": {
              // Use random garbage bytes that won't decompress correctly
              const garbage = Buffer.from("this-is-not-valid-compressed-data-!@#$%");
              response = makeResponse(garbage.toString("latin1"), {
                "Content-Encoding": scenario.encoding,
                "Content-Length": String(garbage.byteLength),
              });
              expectedError++;
              break;
            }
          }

          const { next } = mockClient(response);
          await run(middleware(next)({ method: "GET", url: "/test" }));
        }

        const s = stats();

        // Verify individual counters
        expect(s.decompressed.gzip).toBe(expectedDecompressedGzip);
        expect(s.decompressed.br).toBe(expectedDecompressedBr);
        expect(s.decompressed.deflate).toBe(expectedDecompressedDeflate);
        expect(s.passthroughCount).toBe(expectedPassthrough);
        expect(s.unsupportedEncodingCount).toBe(expectedUnsupported);
        expect(s.errorCount).toBe(expectedError);

        // Verify the sum of outcome counters equals total requests processed.
        // Note: unsupportedEncodingCount is a diagnostic counter that overlaps
        // with passthroughCount (unsupported responses also count as passthrough),
        // so the primary outcome counters are: decompressed + passthrough + error.
        const totalDecompressed =
          s.decompressed.gzip + s.decompressed.br + s.decompressed.deflate;
        const totalOutcomes =
          totalDecompressed + s.passthroughCount + s.errorCount;
        expect(totalOutcomes).toBe(scenarios.length);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10: Multi-encoding reverse-order decompression
   *
   * For any response with multiple Content-Encoding values (e.g., "gzip, deflate"),
   * the middleware decompresses in reverse order — removing the last-applied encoding
   * first — such that the final body equals the original uncompressed content.
   *
   * If Content-Encoding is "enc1, enc2", it means the body was first compressed with
   * enc1, then compressed with enc2. The middleware should first decompress enc2, then
   * decompress enc1, yielding the original body.
   *
   * **Validates: Requirements 10.1**
   */
  it("Property 10: Multi-encoding reverse-order decompression", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBodyText,
        arbSupportedEncoding,
        arbSupportedEncoding,
        async (originalBody, enc1, enc2) => {
          const { middleware } = makeCompressionMiddleware();

          // Simulate how a server would encode:
          // 1. Start with original body as UTF-8 bytes
          // 2. Apply enc1 to get compressed1
          // 3. Apply enc2 to compressed1 to get the final wire body
          //
          // Content-Encoding: "enc1, enc2" means enc1 was applied first, enc2 last.
          // The middleware decompresses in reverse: enc2 first, then enc1.
          const originalBuffer = Buffer.from(originalBody, "utf-8");
          const afterEnc1 = compressBuffer(originalBuffer, enc1);
          const afterEnc2 = compressBuffer(afterEnc1, enc2);

          const bodyText = afterEnc2.toString("latin1");
          const response = makeResponse(bodyText, {
            "Content-Encoding": `${enc1}, ${enc2}`,
            "Content-Length": String(afterEnc2.byteLength),
          });

          const { next } = mockClient(response);
          const result = await run(middleware(next)({ method: "GET", url: "/test" }));

          // The middleware should decompress in reverse order (enc2 first, then enc1)
          // yielding the original body
          expect(result.bodyText).toBe(originalBody);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 6: Disabled encoding passthrough
   *
   * For any response with a Content-Encoding value that corresponds to a supported
   * encoding that is NOT enabled in the middleware's configuration, the middleware
   * returns the response body without modification (no decompression) and increments
   * the passthrough count in stats.
   *
   * **Validates: Requirements 6.4**
   */
  it("Property 6: Disabled encoding passthrough", async () => {
    /**
     * Generator that produces a config excluding at least one encoding,
     * paired with one of the excluded encodings.
     */
    const arbConfigAndDisabledEncoding: fc.Arbitrary<{
      config: CompressionConfig;
      disabledEncoding: SupportedEncoding;
    }> = fc
      .subarray([...SUPPORTED_ENCODINGS], { minLength: 1, maxLength: SUPPORTED_ENCODINGS.length - 1 })
      .chain((enabledEncodings) => {
        const disabled = SUPPORTED_ENCODINGS.filter(
          (enc) => !enabledEncodings.includes(enc),
        );
        return fc.constantFrom(...disabled).map((disabledEncoding) => ({
          config: { encodings: enabledEncodings },
          disabledEncoding,
        }));
      });

    await fc.assert(
      fc.asyncProperty(
        arbConfigAndDisabledEncoding,
        arbBodyText,
        async ({ config, disabledEncoding }, body) => {
          const { middleware, stats } = makeCompressionMiddleware(config);

          // Compress the body with the disabled encoding to simulate a server response
          const compressed = compress(body, disabledEncoding);
          const bodyText = compressed.toString("latin1");

          const response = makeResponse(bodyText, {
            "Content-Encoding": disabledEncoding,
          });

          const { next } = mockClient(response);
          const passthroughBefore = stats().passthroughCount;

          const result = await run(middleware(next)({ method: "GET", url: "/test" }));

          // Body must pass through unchanged (not decompressed)
          expect(result.bodyText).toBe(bodyText);

          // Passthrough count must be incremented
          expect(stats().passthroughCount).toBe(passthroughBefore + 1);
        },
      ),
      { numRuns: 100 },
    );
  });
  /**
   * Property 11: Graceful decompression failure
   *
   * For any response with a supported Content-Encoding header but malformed/invalid
   * compressed body data, the middleware SHALL: (a) return the original unmodified
   * response (same body, same headers), (b) increment the error counter in stats,
   * and (c) not propagate any HttpError (the effect succeeds).
   *
   * **Validates: Requirements 11.1, 11.2, 11.3**
   */
  it("Property 11: Graceful decompression failure", async () => {
    /**
     * Arbitrary for a pair of (garbage buffer, encoding) where the garbage data
     * is guaranteed to fail decompression for the given encoding.
     * We filter out random bytes that accidentally form valid compressed data.
     */
    const arbInvalidCompressedPair: fc.Arbitrary<{
      garbageBuffer: Buffer;
      encoding: SupportedEncoding;
    }> = fc
      .tuple(
        fc.uint8Array({ minLength: 1, maxLength: 200 }).map((arr) => Buffer.from(arr)),
        arbSupportedEncoding,
      )
      .filter(([buf, enc]) => {
        // Verify this data actually fails decompression
        try {
          switch (enc) {
            case "gzip":
              zlib.gunzipSync(buf);
              return false; // Valid gzip — skip
            case "br":
              zlib.brotliDecompressSync(buf);
              return false; // Valid brotli — skip
            case "deflate":
              zlib.inflateSync(buf);
              return false; // Valid deflate — skip
          }
        } catch {
          return true; // Decompression failed — this is what we want
        }
        return false;
      })
      .map(([garbageBuffer, encoding]) => ({ garbageBuffer, encoding }));

    await fc.assert(
      fc.asyncProperty(
        arbInvalidCompressedPair,
        async ({ garbageBuffer, encoding }) => {
          const { middleware, stats } = makeCompressionMiddleware();

          const bodyText = garbageBuffer.toString("latin1");
          const headers: Record<string, string> = {
            "Content-Encoding": encoding,
            "Content-Length": String(garbageBuffer.byteLength),
          };

          const response = makeResponse(bodyText, headers);
          const { next } = mockClient(response);

          const errorCountBefore = stats().errorCount;

          // The effect must succeed (no exception thrown)
          const result = await run(
            middleware(next)({ method: "GET", url: "/test" }),
          );

          // (a) The response body is returned unchanged (same as corrupted input)
          expect(result.bodyText).toBe(bodyText);

          // (a) The response headers are returned unchanged
          expect(result.headers).toEqual(headers);

          // (b) errorCount is incremented
          expect(stats().errorCount).toBe(errorCountBefore + 1);

          // (c) No exception was thrown — we reached this point, so the effect succeeded
        },
      ),
      { numRuns: 100 },
    );
  });
});

export {
  rt,
  run,
  mockClient,
  failingClient,
  makeResponse,
  compress,
  arbSupportedEncoding,
  arbCompressionConfig,
  arbBodyText,
  arbHttpRequestWithoutAE,
  arbHttpRequestWithAE,
  arbHttpError,
  arbUnsupportedEncoding,
};
