import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import { httpBodyByteLength, httpBodyKeyPart, httpBodyToBuffer } from "../body";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { withTracing } from "../tracing";
import { validatedJson } from "../validation";

vi.mock("../../core/runtime/wasmModule", () => ({
  resolveWasmModule: vi.fn(),
}));

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const response = (bodyText: string): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  bodyText,
  ms: 1,
});

describe("HTTP body helpers", () => {
  it("computes byte lengths for undefined, strings, ArrayBuffer, and Uint8Array", () => {
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const uint8 = new Uint8Array([4, 5]);

    expect(httpBodyByteLength(undefined)).toBe(0);
    expect(httpBodyByteLength("ñ")).toBe(Buffer.byteLength("ñ", "utf8"));
    expect(httpBodyByteLength(arrayBuffer)).toBe(3);
    expect(httpBodyByteLength(uint8)).toBe(2);
  });

  it("converts supported bodies to Buffer and stable key parts", () => {
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const uint8 = new Uint8Array([4, 5]);

    expect(httpBodyToBuffer("hello").toString("utf8")).toBe("hello");
    expect(Array.from(httpBodyToBuffer(arrayBuffer))).toEqual([1, 2, 3]);
    expect(Array.from(httpBodyToBuffer(uint8))).toEqual([4, 5]);
    expect(httpBodyKeyPart(undefined)).toBe("");
    expect(httpBodyKeyPart("plain")).toBe("plain");
    expect(httpBodyKeyPart(uint8)).toBe(`base64:${Buffer.from(uint8).toString("base64")}`);
  });
});

describe("validatedJson", () => {
  const req: HttpRequest = { method: "GET", url: "https://example.test/user" };

  it("returns parsed data when the validator succeeds", async () => {
    const client: HttpClientFn = () => asyncSucceed(response(JSON.stringify({ id: 1 })));
    const getUser = validatedJson(client, (data) =>
      typeof data === "object" && data !== null && "id" in data
        ? { success: true, data: data as { id: number } }
        : { success: false, error: "missing id" }
    );

    await expect(run(getUser(req))).resolves.toEqual({ id: 1 });
  });

  it("propagates upstream HttpError failures", async () => {
    const error: HttpError = { _tag: "FetchError", message: "down" };
    const client: HttpClientFn = () => asyncFail(error);
    const getJson = validatedJson(client, () => ({ success: true, data: "never" }));

    await expect(run(getJson(req))).rejects.toEqual(error);
  });

  it("returns ValidationError for validator failures and parse failures", async () => {
    const invalidShape: HttpClientFn = () => asyncSucceed(response(JSON.stringify({ name: "Ada" })));
    const invalidJson: HttpClientFn = () => asyncSucceed(response("{"));

    await expect(
      run(validatedJson(invalidShape, () => ({ success: false, error: "bad shape" }))(req))
    ).rejects.toMatchObject({ _tag: "ValidationError", message: "bad shape" });

    await expect(
      run(validatedJson(invalidJson, () => ({ success: true, data: "never" }))(req))
    ).rejects.toMatchObject({ _tag: "ValidationError", message: expect.stringContaining("JSON parse error") });
  });
});

describe("withTracing", () => {
  it("wraps requests in tracer spans with HTTP attributes", async () => {
    const span = vi.fn((_name, effect) => effect);
    const tracer = { span, spans: () => [], clear: () => undefined };
    const client: HttpClientFn = () => asyncSucceed(response("{}"));
    const wrapped = withTracing(tracer)(client);

    await expect(run(wrapped({
      method: "POST",
      url: "https://example.test/items",
      headers: { "content-type": "application/json" },
    }))).resolves.toMatchObject({ status: 200 });

    expect(span).toHaveBeenCalledWith(
      "HTTP POST https://example.test/items",
      expect.any(Object),
      {
        "http.method": "POST",
        "http.url": "https://example.test/items",
        "http.content_type": "application/json",
      },
    );
  });

  it("omits content type attribute when the request has no content-type header", async () => {
    const span = vi.fn((_name, effect) => effect);
    const tracer = { span, spans: () => [], clear: () => undefined };
    const wrapped = withTracing(tracer)(() => asyncSucceed(response("{}")));

    await run(wrapped({ method: "GET", url: "https://example.test/items" }));

    expect(span.mock.calls[0]![2]).toEqual({
      "http.method": "GET",
      "http.url": "https://example.test/items",
    });
  });
});

describe("WasmRetryPlannerBridge", () => {
  it("adapts the WASM retry planner API and metrics", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { WasmRetryPlannerBridge } = await import("../retry/wasmRetryPlanner");
    const calls: unknown[][] = [];

    class FakePlanner {
      start(...args: unknown[]) {
        calls.push(args);
        return 7;
      }
      next_delay_ms(_retryId: number, _nowMs: number, retryable: boolean, retryAfterMs: number) {
        if (!retryable) return -1;
        return retryAfterMs >= 0 ? retryAfterMs : 25;
      }
      drop_state(retryId: number) {
        calls.push(["drop", retryId]);
        return true;
      }
      metric_u64(id: number) {
        return id + 10;
      }
    }

    const planner = new WasmRetryPlannerBridge(FakePlanner);

    expect(planner.start({ nowMs: 1, maxRetries: 2, baseDelayMs: 3, maxDelayMs: 4 })).toBe(7);
    expect(calls[0]).toEqual([1, 2, 3, 4, -1, BigInt(Math.floor(0.5 * Number.MAX_SAFE_INTEGER))]);
    expect(planner.nextDelayMs(7, { nowMs: 10, retryable: true })).toBe(25);
    expect(planner.nextDelayMs(7, { nowMs: 10, retryable: true, retryAfterMs: 9 })).toBe(9);
    expect(planner.nextDelayMs(7, { nowMs: 10, retryable: false })).toBeUndefined();

    planner.drop(7);
    expect(calls).toContainEqual(["drop", 7]);
    expect(planner.stats()).toEqual({ live: 10, planned: 11, exhausted: 12, dropped: 13 });
  });

  it("constructs from resolved WASM module and throws when unavailable", async () => {
    const wasmModule = await import("../../core/runtime/wasmModule");
    const { makeWasmRetryPlanner, WasmRetryPlannerBridge } = await import("../retry/wasmRetryPlanner");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    class FakePlanner {
      start() { return 1; }
      next_delay_ms() { return -1; }
      drop_state() { return true; }
      metric_u64() { return 0; }
    }

    resolveWasmModule.mockReturnValueOnce({ BrassWasmRetryPlanner: FakePlanner });
    expect(makeWasmRetryPlanner()).toBeInstanceOf(WasmRetryPlannerBridge);

    resolveWasmModule.mockReturnValueOnce({});
    expect(() => makeWasmRetryPlanner()).toThrow(/wasm retry planner is not available/);
  });
});
