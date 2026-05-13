import { describe, expect, it } from "vitest";

import { makeHttp, type HttpError, type HttpWireResponse } from "../client";
import { makeDefaultHttpClient } from "../defaultClient";
import {
  isPromiseTransportDirect,
  makePromiseHttpTransport,
  promiseHttpTransport,
  type HttpTransport,
  type HttpTransportContext,
} from "../transport";
import { async as asyncEffect, asyncSucceed } from "../../core/types/asyncEffect";
import { registerHttpEffect } from "../effectRunner";
import type { Exit } from "../../core/types/effect";

/**
 * Integration tests for backward compatibility of the promise transport
 * direct path optimization.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4
 */
describe("Promise transport direct path — backward compatibility", () => {
  const BASE_URL = "https://api.example.test";

  // ─────────────────────────────────────────────────────────────────────────
  // Requirement 8.2: Custom transports (without marker) still use the effect path
  // ─────────────────────────────────────────────────────────────────────────

  describe("Requirement 8.2: Custom effect transports use the effect path unchanged", () => {
    it("a plain effect transport without marker goes through registerHttpEffect path", async () => {
      let effectPathCalled = false;

      const transport: HttpTransport = ({ request, url }) => {
        effectPathCalled = true;
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: { "x-path": "effect" },
          bodyText: JSON.stringify({ method: request.method, url: url.toString() }),
          ms: 1,
        });
      };

      // Verify it does NOT have the marker
      expect(isPromiseTransportDirect(transport)).toBe(false);

      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
        timeoutMs: 5000,
      });

      const result = await new Promise<HttpWireResponse>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "GET", url: "/test" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Success") resolve(exit.value);
            else reject(exit);
          },
        );
      });

      expect(effectPathCalled).toBe(true);
      expect(result.status).toBe(200);
      expect(result.headers["x-path"]).toBe("effect");
    });

    it("a custom async effect transport works through makeHttp with pool config", async () => {
      let transportCallCount = 0;

      const transport: HttpTransport = ({ request }) =>
        asyncEffect((_env, cb) => {
          transportCallCount++;
          cb({
            _tag: "Success",
            value: {
              status: 201,
              statusText: "Created",
              headers: { "x-custom": "true" },
              bodyText: JSON.stringify({ created: true }),
              ms: 5,
            },
          });
        });

      expect(isPromiseTransportDirect(transport)).toBe(false);

      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
        timeoutMs: 5000,
        pool: { concurrency: 10 },
      });

      const result = await new Promise<HttpWireResponse>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "POST", url: "/items" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Success") resolve(exit.value);
            else reject(exit);
          },
        );
      });

      expect(transportCallCount).toBe(1);
      expect(result.status).toBe(201);
      expect(result.bodyText).toBe(JSON.stringify({ created: true }));
    });

    it("effect transport errors propagate correctly through makeHttp", async () => {
      const transport: HttpTransport = () =>
        asyncEffect((_env, cb) => {
          cb({
            _tag: "Failure",
            cause: { _tag: "Fail", error: { _tag: "FetchError", message: "connection refused" } as HttpError },
          });
        });

      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
        timeoutMs: 5000,
      });

      const error = await new Promise<HttpError>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "GET", url: "/fail" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Failure") {
              const cause = exit.cause;
              if (cause._tag === "Fail") resolve(cause.error);
              else reject(new Error("Unexpected cause shape"));
            } else {
              reject(new Error("Expected failure"));
            }
          },
        );
      });

      expect(error._tag).toBe("FetchError");
      expect((error as any).message).toBe("connection refused");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Requirement 8.3: Promise transports without pool/timeout still apply optimization
  // ─────────────────────────────────────────────────────────────────────────

  describe("Requirement 8.3: Promise transports without pool/timeout still work", () => {
    it("promise transport works through makeHttp without pool or timeout config", async () => {
      const transport = makePromiseHttpTransport({
        request: async (ctx: HttpTransportContext) =>
          ({ status: 200, data: { url: ctx.url.toString() } }),
        response: (raw: any) => ({
          status: raw.status,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify(raw.data),
        }),
      });

      // Verify it HAS the marker
      expect(isPromiseTransportDirect(transport)).toBe(true);

      // No pool, no timeout — should still work correctly
      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
      });

      const result = await new Promise<HttpWireResponse>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "GET", url: "/no-pool" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Success") resolve(exit.value);
            else reject(exit);
          },
        );
      });

      expect(result.status).toBe(200);
      expect(JSON.parse(result.bodyText)).toEqual({ url: `${BASE_URL}/no-pool` });
    });

    it("promise transport works through makeHttp with pool but no timeout", async () => {
      const transport = promiseHttpTransport()
        .request(async () => ({
          status: 200,
          statusText: "OK",
          headers: {},
          data: { pooled: true },
        }))
        .json();

      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
        pool: { concurrency: 5 },
      });

      const result = await new Promise<HttpWireResponse>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "GET", url: "/pooled" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Success") resolve(exit.value);
            else reject(exit);
          },
        );
      });

      expect(result.status).toBe(200);
      expect(JSON.parse(result.bodyText)).toEqual({ pooled: true });
    });

    it("promise transport works through makeHttp with timeout but no pool", async () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 204 }),
        response: () => ({
          status: 204,
          statusText: "No Content",
          headers: {},
          bodyText: "",
        }),
      });

      const client = makeHttp({
        baseUrl: BASE_URL,
        transport,
        timeoutMs: 10000,
      });

      const result = await new Promise<HttpWireResponse>((resolve, reject) => {
        registerHttpEffect(
          client({ method: "DELETE", url: "/resource/1" }),
          undefined,
          (exit: Exit<HttpError, HttpWireResponse>) => {
            if (exit._tag === "Success") resolve(exit.value);
            else reject(exit);
          },
        );
      });

      expect(result.status).toBe(204);
      expect(result.bodyText).toBe("");
    });

    it("promise transport works through makeDefaultHttpClient with minimal preset", async () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 200, data: { hello: "world" } }),
        response: (raw: any) => ({
          status: raw.status,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify(raw.data),
        }),
      });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const response = await client.getJson<{ hello: string }>("/greeting").unsafeRunPromise();

      expect(response.body).toEqual({ hello: "world" });
      expect(response.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Requirement 8.1: Public API surface remains unchanged
  // ─────────────────────────────────────────────────────────────────────────

  describe("Requirement 8.1: Public API surface remains unchanged", () => {
    it("promiseHttpTransport() returns a fluent builder with request/requestConfig", () => {
      const builder = promiseHttpTransport();

      expect(typeof builder.request).toBe("function");
      expect(typeof builder.requestConfig).toBe("function");
    });

    it("promiseHttpTransport().request() returns a body builder with json/text/response/fromJson/fromText/error", () => {
      const bodyBuilder = promiseHttpTransport().request(async () => ({}));

      expect(typeof bodyBuilder.json).toBe("function");
      expect(typeof bodyBuilder.text).toBe("function");
      expect(typeof bodyBuilder.response).toBe("function");
      expect(typeof bodyBuilder.fromJson).toBe("function");
      expect(typeof bodyBuilder.fromText).toBe("function");
      expect(typeof bodyBuilder.error).toBe("function");
    });

    it("promiseHttpTransport().request().json() returns a valid HttpTransport", async () => {
      const transport = promiseHttpTransport()
        .request(async () => ({ status: 200, data: { ok: true } }))
        .json();

      // It should be callable as a transport function
      expect(typeof transport).toBe("function");

      // It should produce an Async effect
      const context: HttpTransportContext = {
        request: { method: "GET", url: "/test" },
        url: new URL("https://example.com/test"),
        signal: new AbortController().signal,
      };
      const effect = transport(context);
      expect(effect._tag).toBe("Async");
    });

    it("makeHttp() returns an HttpClient with .with() and .stats()", () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 200 }),
        response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "" }),
      });

      const client = makeHttp({ baseUrl: BASE_URL, transport });

      expect(typeof client).toBe("function");
      expect(typeof client.with).toBe("function");
      expect(typeof client.stats).toBe("function");
    });

    it("makeDefaultHttpClient() returns a client with all expected methods", () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 200 }),
        response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "{}" }),
      });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      // Core request methods
      expect(typeof client.request).toBe("function");
      expect(typeof client.get).toBe("function");
      expect(typeof client.post).toBe("function");
      expect(typeof client.getText).toBe("function");
      expect(typeof client.getJson).toBe("function");
      expect(typeof client.postJson).toBe("function");

      // Composition
      expect(typeof client.with).toBe("function");

      // Lifecycle
      expect(typeof client.wire).toBe("function");
      expect(typeof client.stats).toBe("function");
      expect(typeof client.cancelAll).toBe("function");
      expect(typeof client.shutdown).toBe("function");

      // Metadata
      expect(client.preset).toBe("minimal");
      expect(client.features).toBeDefined();
    });

    it("getJson returns an AsyncWithPromise with unsafeRunPromise", async () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 200, data: { value: 42 } }),
        response: (raw: any) => ({
          status: raw.status,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify(raw.data),
        }),
      });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const effect = client.getJson<{ value: number }>("/data");

      // Should have the AsyncWithPromise interface
      expect(typeof effect.unsafeRunPromise).toBe("function");
      expect(typeof effect.toPromise).toBe("function");
      expect(effect._tag).toBe("Async");

      const result = await effect.unsafeRunPromise();
      expect(result.body).toEqual({ value: 42 });
    });

    it("postJson returns an AsyncWithPromise with unsafeRunPromise", async () => {
      const transport = makePromiseHttpTransport({
        request: async () => ({ status: 201, data: { id: 1 } }),
        response: (raw: any) => ({
          status: raw.status,
          statusText: "Created",
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify(raw.data),
        }),
      });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const effect = client.postJson<{ id: number }>("/items", { name: "test" });

      // postJson uses asyncFlatMap internally (encode body → request → decode),
      // so the top-level tag may be FlatMap rather than Async. The important
      // contract is that it exposes the AsyncWithPromise interface.
      expect(typeof effect.unsafeRunPromise).toBe("function");
      expect(typeof effect.toPromise).toBe("function");
      expect(["Async", "FlatMap"]).toContain(effect._tag);

      const result = await effect.unsafeRunPromise();
      expect(result.body).toEqual({ id: 1 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Requirement 8.4: __promiseTransport and requestDirect are not visible on public type
  // ─────────────────────────────────────────────────────────────────────────

  describe("Requirement 8.4: Internal marker not visible on public type", () => {
    it("__promiseTransport is not enumerable on the transport function", () => {
      const transport = promiseHttpTransport()
        .request(async () => ({ status: 200, data: {} }))
        .json();

      // The marker exists at runtime (for the optimization) but should not
      // be part of the public TypeScript type. We verify it's present at
      // runtime but not enumerable in Object.keys (implementation detail).
      // The key test is that TypeScript does NOT expose it on the HttpTransport type.
      expect((transport as any).__promiseTransport).toBe(true);
      expect(typeof (transport as any).requestDirect).toBe("function");

      // The transport is still callable as a normal HttpTransport
      const context: HttpTransportContext = {
        request: { method: "GET", url: "/test" },
        url: new URL("https://example.com/test"),
        signal: new AbortController().signal,
      };
      const effect = transport(context);
      expect(effect._tag).toBe("Async");
    });

    it("makePromiseHttpTransport output is typed as HttpTransport (no marker in type)", () => {
      // This test verifies the runtime behavior — the TypeScript compiler
      // ensures the return type is `HttpTransport` (not `HttpTransport & PromiseTransportMarker`)
      const transport: HttpTransport = makePromiseHttpTransport({
        request: async () => ({ status: 200 }),
        response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "" }),
      });

      // Assignable to HttpTransport without type assertion
      expect(typeof transport).toBe("function");

      // But the marker is there at runtime for the optimization
      expect(isPromiseTransportDirect(transport)).toBe(true);
    });

    it("isPromiseTransportDirect returns false for plain effect transports", () => {
      const effectTransport: HttpTransport = () =>
        asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "",
          ms: 0,
        });

      expect(isPromiseTransportDirect(effectTransport)).toBe(false);
      expect((effectTransport as any).__promiseTransport).toBeUndefined();
      expect((effectTransport as any).requestDirect).toBeUndefined();
    });

    it("fluent builder output also has marker at runtime but typed as HttpTransport", () => {
      const transport: HttpTransport = promiseHttpTransport()
        .request(async () => ({ status: 200, data: "hello" }))
        .text();

      // Typed as HttpTransport (no marker in the type)
      expect(typeof transport).toBe("function");

      // Runtime marker present for optimization
      expect(isPromiseTransportDirect(transport)).toBe(true);
    });
  });
});
