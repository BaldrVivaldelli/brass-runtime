import { describe, expect, it } from "vitest";

import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed, type Async } from "../../core/types/asyncEffect";
import { Cause, type Exit } from "../../core/types/effect";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { withDedup } from "../lifecycle/dedup";
import { resolveHttpPoolKey } from "../pool";
import { buildHttpRequest } from "../requestBuilder";
import {
  defineHttpPolicyPresets,
  getHttpRequestPolicy,
  httpPolicy,
  withHttpPolicyPresets,
  withHttpRequestPolicy,
} from "../requestPolicy";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const response = (bodyText = "ok"): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText,
  ms: 1,
});

function delayedClient(): {
  readonly client: HttpClientFn;
  readonly calls: HttpRequest[];
  readonly resolveAll: (res: HttpWireResponse) => void;
} {
  const calls: HttpRequest[] = [];
  const pending: Array<(res: HttpWireResponse) => void> = [];

  const client: HttpClientFn = (req): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
      calls.push(req);
      pending.push((res) => cb({ _tag: "Success", value: res }));
      return () => cb({ _tag: "Failure", cause: Cause.interrupt() });
    },
  });

  return {
    client,
    calls,
    resolveAll: (res) => {
      for (const resolve of pending.splice(0)) resolve(res);
    },
  };
}

describe("HTTP request policy", () => {
  it("builds structured request policy from DX init without leaking policy fields into fetch init", () => {
    const req = buildHttpRequest("GET", "/users", {
      headers: { accept: "application/json" },
      policy: { lane: "users" },
      dedupKey: "users:list",
      priority: 1,
      retry: false,
      poolKey: "api-users",
      cache: "no-store",
    } as any);

    expect(getHttpRequestPolicy(req)).toEqual({
      lane: "users",
      dedupKey: "users:list",
      priority: 1,
      retry: false,
      poolKey: "api-users",
    });
    expect(req.init).toEqual({ cache: "no-store" });
    expect(req.poolKey).toBe("api-users");
    expect(req.headers).toEqual({ accept: "application/json" });
  });

  it("keeps legacy top-level fields while letting structured policy win", () => {
    const req = withHttpRequestPolicy(
      {
        method: "GET",
        url: "https://example.test/users",
        priority: 8,
        poolKey: "legacy-pool",
        policy: { priority: 4 },
      },
      { priority: 2, poolKey: "policy-pool" },
    );

    expect(req.priority).toBe(2);
    expect(req.poolKey).toBe("policy-pool");
    expect(getHttpRequestPolicy(req)).toMatchObject({
      priority: 2,
      poolKey: "policy-pool",
    });
    expect(resolveHttpPoolKey("origin", req, new URL(req.url))).toBe("policy-pool");
  });

  it("uses policy.dedupKey as the per-request dedup override", async () => {
    const { client, calls, resolveAll } = delayedClient();
    const dedup = withDedup()(client);

    const first = run<HttpWireResponse>(dedup({
      method: "GET",
      url: "https://example.test/a",
      policy: { dedupKey: "shared" },
    }));
    const second = run<HttpWireResponse>(dedup({
      method: "GET",
      url: "https://example.test/b",
      policy: { dedupKey: "shared" },
    }));

    await flush();
    expect(calls).toHaveLength(1);

    resolveAll(response("shared"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      response("shared"),
      response("shared"),
    ]);
  });

  it("supports named policy shorthand and preset overrides", () => {
    const presets = defineHttpPolicyPresets({
      readModel: {
        lane: "read-model",
        poolKey: "users-api",
        priority: 4,
        retry: { maxRetries: 2 },
      },
      fastLane: httpPolicy.lane("fast-lane", { priority: 1 }),
    });

    const shorthand = buildHttpRequest("GET", "/users", {
      policy: "readModel",
    });
    const overridden = buildHttpRequest("GET", "/users/1", {
      policy: {
        preset: "readModel",
        dedupKey: "users:1",
        priority: 0,
      },
    });

    expect(getHttpRequestPolicy(shorthand, { presets })).toEqual({
      preset: "readModel",
      lane: "read-model",
      poolKey: "users-api",
      priority: 4,
      retry: { maxRetries: 2 },
    });
    expect(getHttpRequestPolicy(overridden, { presets })).toEqual({
      preset: "readModel",
      lane: "read-model",
      poolKey: "users-api",
      dedupKey: "users:1",
      priority: 0,
      retry: { maxRetries: 2 },
    });
    expect(getHttpRequestPolicy(buildHttpRequest("GET", "/fast", { policy: "fastLane" }), { presets })).toMatchObject({
      preset: "fastLane",
      lane: "fast-lane",
      priority: 1,
    });
  });

  it("resolves policy presets through middleware before downstream layers", async () => {
    const calls: HttpRequest[] = [];
    const client: HttpClientFn = (req) => {
      calls.push(req);
      return asyncSucceed(response());
    };
    const withPresets = withHttpPolicyPresets({
      readModel: { lane: "read-model", poolKey: "users-api", priority: 2 },
    })(client);

    await expect(run<HttpWireResponse>(withPresets({
      method: "GET",
      url: "https://example.test/users",
      policy: "readModel",
    }))).resolves.toMatchObject({ status: 200 });

    expect(calls).toHaveLength(1);
    expect(getHttpRequestPolicy(calls[0]!)).toEqual({
      preset: "readModel",
      lane: "read-model",
      poolKey: "users-api",
      priority: 2,
    });
    expect(calls[0]!.poolKey).toBe("users-api");
    expect(calls[0]!.priority).toBe(2);
  });
});
