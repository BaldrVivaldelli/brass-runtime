import { afterEach, describe, expect, it, vi } from "vitest";

import { makeDefaultHttpClient } from "../defaultClient";
import { makePromiseHttpTransport } from "../transport";
import type { HttpTransportContext } from "../transport";
import type { HttpMiddleware } from "../client";
import { s } from "../../schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Unit tests for the inline JSON decode optimization in `makeDefaultHttpClient`.
 *
 * When a promise transport is used with no middleware configured, `getJson` should
 * decode JSON directly in the transport success callback (fused path), avoiding
 * the `asyncFlatMap` + NativeTopLevelRunner FlatMap continuation overhead.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
describe("Inline JSON decode path", () => {
  const BASE_URL = "https://api.example.test";

  function makeTestTransport(responseBody: string, options?: { status?: number; headers?: Record<string, string> }) {
    return makePromiseHttpTransport({
      request: (_ctx: HttpTransportContext) => Promise.resolve({ data: responseBody }),
      response: () => ({
        status: options?.status ?? 200,
        statusText: "OK",
        headers: options?.headers ?? { "content-type": "application/json" },
        bodyText: responseBody,
      }),
    });
  }

  describe("Requirement 5.1: Successful JSON decode produces correct HttpResponse shape", () => {
    it("decodes valid JSON and produces HttpResponse with parsed body, status, headers", async () => {
      const body = { id: 1, name: "Alice", active: true };
      const transport = makeTestTransport(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "abc123" },
      });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const response = await client.getJson<typeof body>("/users/1").unsafeRunPromise();

      expect(response.body).toEqual(body);
      expect(response.status).toBe(200);
      expect(response.statusText).toBe("OK");
      expect(response.headers).toMatchObject({
        "content-type": "application/json",
        "x-request-id": "abc123",
      });
    });

    it("decodes nested JSON objects correctly", async () => {
      const body = {
        users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
        meta: { total: 2, page: 1 },
      };
      const transport = makeTestTransport(JSON.stringify(body));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const response = await client.getJson<typeof body>("/users").unsafeRunPromise();

      expect(response.body).toEqual(body);
      expect(response.status).toBe(200);
    });

    it("decodes JSON arrays at the top level", async () => {
      const body = [1, 2, 3, 4, 5];
      const transport = makeTestTransport(JSON.stringify(body));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const response = await client.getJson<number[]>("/numbers").unsafeRunPromise();

      expect(response.body).toEqual(body);
    });
  });

  describe("Requirement 5.3: Invalid JSON produces ValidationError with phase: response", () => {
    it("produces ValidationError when body is not valid JSON", async () => {
      const transport = makeTestTransport("not valid json {{{");

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      await expect(client.getJson("/data").unsafeRunPromise()).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
      });
    });

    it("includes a descriptive message about the parse error", async () => {
      const transport = makeTestTransport("<html>not json</html>");

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      await expect(client.getJson("/data").unsafeRunPromise()).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
        message: expect.stringContaining("JSON parse error"),
      });
    });

    it("includes the original body text in the error", async () => {
      const invalidBody = "definitely not json";
      const transport = makeTestTransport(invalidBody);

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      await expect(client.getJson("/data").unsafeRunPromise()).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
        body: invalidBody,
      });
    });
  });

  describe("Requirement 5.5: Schema validation failure produces ValidationError", () => {
    it("produces ValidationError when parsed JSON does not match schema", async () => {
      const UserSchema = s.object({
        id: s.number({ int: true }),
        name: s.string({ minLength: 1 }),
      });

      // Response has id as string instead of number
      const transport = makeTestTransport(JSON.stringify({ id: "not-a-number", name: "Alice" }));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      await expect(
        client.getJson("/users/1", { schema: UserSchema }).unsafeRunPromise(),
      ).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["id"] }),
        ]),
      });
    });

    it("produces ValidationError with schema name when provided", async () => {
      const UserSchema = s.object({
        id: s.number(),
        name: s.string(),
      });

      const transport = makeTestTransport(JSON.stringify({ id: "bad", name: 123 }));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      await expect(
        client.getJson("/users/1", { schema: UserSchema, schemaName: "User" }).unsafeRunPromise(),
      ).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
        schema: "User",
      });
    });

    it("succeeds when parsed JSON matches the schema", async () => {
      const UserSchema = s.object({
        id: s.number({ int: true }),
        name: s.string({ minLength: 1 }),
      });

      const body = { id: 42, name: "Bob" };
      const transport = makeTestTransport(JSON.stringify(body));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      const response = await client.getJson("/users/42", { schema: UserSchema }).unsafeRunPromise();

      expect(response.body).toEqual(body);
      expect(response.status).toBe(200);
    });
  });

  describe("Requirement 5.4: Middleware-configured client falls back to asyncFlatMap path", () => {
    it("still produces correct results when middleware is configured", async () => {
      const body = { id: 1, name: "Alice" };
      const transport = makeTestTransport(JSON.stringify(body));

      const addHeader: HttpMiddleware = (next) => (req) =>
        next({
          ...req,
          headers: { ...(req.headers ?? {}), "x-custom": "1" },
        });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
        middleware: [addHeader],
      });

      const response = await client.getJson<typeof body>("/users/1").unsafeRunPromise();

      expect(response.body).toEqual(body);
      expect(response.status).toBe(200);
    });

    it("falls back to asyncFlatMap path when .with() adds middleware", async () => {
      const body = { value: 42 };
      const transport = makeTestTransport(JSON.stringify(body));

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
      });

      // Adding middleware via .with() should disable inline decode
      const addHeader: HttpMiddleware = (next) => (req) =>
        next({ ...req, headers: { ...(req.headers ?? {}), "x-added": "1" } });

      const clientWithMw = client.with(addHeader);

      const response = await clientWithMw.getJson<typeof body>("/data").unsafeRunPromise();

      expect(response.body).toEqual(body);
      expect(response.status).toBe(200);
    });

    it("handles invalid JSON correctly on the fallback path too", async () => {
      const transport = makeTestTransport("not json");

      const addHeader: HttpMiddleware = (next) => (req) =>
        next({ ...req, headers: { ...(req.headers ?? {}), "x-mw": "1" } });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
        middleware: [addHeader],
      });

      await expect(client.getJson("/data").unsafeRunPromise()).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
      });
    });

    it("handles schema validation failure correctly on the fallback path", async () => {
      const UserSchema = s.object({
        id: s.number(),
        name: s.string(),
      });

      const transport = makeTestTransport(JSON.stringify({ id: "bad", name: 123 }));

      const addHeader: HttpMiddleware = (next) => (req) =>
        next({ ...req, headers: { ...(req.headers ?? {}), "x-mw": "1" } });

      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "minimal",
        compression: false,
        transport,
        middleware: [addHeader],
      });

      await expect(
        client.getJson("/users/1", { schema: UserSchema }).unsafeRunPromise(),
      ).rejects.toMatchObject({
        _tag: "ValidationError",
        phase: "response",
      });
    });
  });
});
