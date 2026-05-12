import { describe, expect, it } from "vitest";

import { buildHttpRequest, splitHttpRequestInit } from "../requestBuilder";
import { s } from "../../schema";

describe("HTTP request builder", () => {
  it("splits fetch init from Brass-only request metadata", () => {
    const schema = s.object({ ok: s.boolean() });
    const init = {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: 250,
      poolKey: "users",
      schema,
      schemaName: "User",
      bodySchema: schema,
      bodySchemaName: "CreateUser",
      cache: "no-store" as const,
      credentials: "include" as const,
    };

    const split = splitHttpRequestInit(init);

    expect(split).toEqual({
      headers: { accept: "application/json" },
      timeoutMs: 250,
      poolKey: "users",
      init: {
        cache: "no-store",
        credentials: "include",
      },
    });
    expect(init).toHaveProperty("schema", schema);
  });

  it("builds HttpRequest values without leaking schemas to RequestInit", () => {
    const schema = s.object({ ok: s.boolean() });

    const req = buildHttpRequest(
      "POST",
      "/users",
      {
        headers: [["x-api-key", "secret"]],
        timeoutMs: 500,
        poolKey: "api",
        schema,
        bodySchema: schema,
        redirect: "manual",
      },
      JSON.stringify({ name: "Ada" }),
    );

    expect(req).toMatchObject({
      method: "POST",
      url: "/users",
      headers: { "x-api-key": "secret" },
      timeoutMs: 500,
      poolKey: "api",
      body: JSON.stringify({ name: "Ada" }),
      init: { redirect: "manual" },
    });
    expect(req.init).not.toHaveProperty("schema");
    expect(req.init).not.toHaveProperty("bodySchema");
  });

  it("keeps empty string bodies omitted for existing DX helper compatibility", () => {
    expect(buildHttpRequest("POST", "/empty", undefined, "")).not.toHaveProperty("body");
  });
});
