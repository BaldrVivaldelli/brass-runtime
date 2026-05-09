import { afterEach, describe, expect, it, vi } from "vitest";

import {
  httpClientBuilder,
  makeDefaultHttpClient,
  s,
  validatedJson,
} from "../index";
import {
  makeJsonFetchResponse,
  makeJsonHttpResponse,
  makeMockHttpClient,
  runHttpEffect,
  withMockFetch,
} from "../testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP schema validation", () => {
  it("validates JSON values with path-rich issues and inferred object shape", () => {
    const User = s.object({
      id: s.number({ int: true, min: 1 }),
      name: s.string({ minLength: 1 }),
      role: s.enum(["admin", "user"] as const).optional(),
      tags: s.array(s.string()),
    });

    const parsed = User.safeParse({ id: 1, name: "Ada", tags: ["ops"] });
    expect(parsed).toEqual({
      success: true,
      data: { id: 1, name: "Ada", tags: ["ops"] },
    });

    const bad = User.safeParse({ id: "1", name: "", tags: ["ok", 2] });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.issues.map((issue) => issue.path)).toEqual([
        ["id"],
        ["name"],
        ["tags", 1],
      ]);
    }
  });

  it("validates getJson responses and returns ValidationError instead of unsafe casts", async () => {
    const User = s.object({
      id: s.number({ int: true }),
      name: s.string(),
    });

    const fetchMock = vi.fn(async () => makeJsonFetchResponse({ id: 1, name: "Ada" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "minimal",
      compression: false,
    });

    const response = await client.getJson("/users/1", { schema: User }).unsafeRunPromise();

    expect(response.body).toEqual({ id: 1, name: "Ada" });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("schema");

    fetchMock.mockResolvedValueOnce(makeJsonFetchResponse({ id: "1", name: "Ada" }));

    await expect(client.getJson("/users/2", { schema: User }).unsafeRunPromise())
      .rejects
      .toMatchObject({
        _tag: "ValidationError",
        issues: [expect.objectContaining({ path: ["id"] })],
      });
  });

  it("validates postJson request bodies before fetch", async () => {
    const CreateUser = s.object({
      name: s.string({ minLength: 1 }),
    });
    const fetchMock = vi.fn(async () => makeJsonFetchResponse({ id: 1, name: "Ada" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "minimal",
      compression: false,
    });

    await expect(
      client.postJson("/users", { name: "" }, { bodySchema: CreateUser }).unsafeRunPromise(),
    ).rejects.toMatchObject({
      _tag: "ValidationError",
      phase: "request",
      issues: [expect.objectContaining({ path: ["name"] })],
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      client.postJson("/users", { name: "Ada" }, { bodySchema: CreateUser }).unsafeRunPromise(),
    ).resolves.toMatchObject({ body: { id: 1, name: "Ada" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps validatedJson compatible with schema objects", async () => {
    const client = makeMockHttpClient(() => makeJsonHttpResponse({ ok: true }));
    const validate = validatedJson(client, s.object({ ok: s.boolean() }));

    await expect(runHttpEffect(validate({ method: "GET", url: "/health" })))
      .resolves
      .toEqual({ ok: true });
  });
});

describe("HTTP builder and test helpers", () => {
  it("builds a discoverable default client chain", async () => {
    const User = s.object({ ok: s.boolean() });

    await withMockFetch(
      async () => makeJsonFetchResponse({ ok: true }),
      async (mock) => {
        const client = httpClientBuilder()
          .baseUrl("https://api.example.test")
          .minimal()
          .balancedLimiter({ maxLimit: 24 })
          .noCompression()
          .header("x-api-key", "secret")
          .build();

        const response = await client.getJson("/health", { schema: User }).unsafeRunPromise();

        expect(response.body.ok).toBe(true);
        expect(client.features.compression).toBe(false);
        expect(client.features.adaptiveLimiter).toBe(true);
        expect(client.wire.adaptiveLimiter?.stats().limit).toBe(16);
        expect(mock.lastCall()?.init?.headers).toMatchObject({ "x-api-key": "secret" });
      },
    );
  });

  it("provides a dependency-free mock HTTP client for adopters' tests", async () => {
    const client = makeMockHttpClient((req) => makeJsonHttpResponse({ url: req.url }));

    const response = await runHttpEffect(client({ method: "GET", url: "/users/1" }));

    expect(JSON.parse(response.bodyText)).toEqual({ url: "/users/1" });
    expect(client.calledTimes()).toBe(1);
    expect(client.lastRequest()).toMatchObject({ method: "GET", url: "/users/1" });
  });
});
