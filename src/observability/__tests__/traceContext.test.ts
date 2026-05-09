import { describe, expect, it } from "vitest";

import { asyncFlatMap, asyncSucceed } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../../http/client";
import {
  extractTraceContext,
  injectBaggage,
  formatTraceparent,
  injectTraceContext,
  makeObservability,
  makeRequestObservabilityContext,
  parseTraceparent,
  withHttpObservability,
} from "../index";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

const ok = (): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText: "ok",
  ms: 3,
});

describe("W3C trace context", () => {
  it("parses, formats, extracts, and injects trace context headers", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";

    expect(parseTraceparent(traceparent)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: false,
    });
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeUndefined();

    const extracted = extractTraceContext({
      TraceParent: traceparent,
      tracestate: "vendor=value",
      baggage: "tenant=acme,user=ada%20lovelace",
    });
    expect(extracted).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: false,
      traceState: "vendor=value",
      baggage: { tenant: "acme", user: "ada lovelace" },
    });

    expect(formatTraceparent({ traceId: "trace-id", spanId: "span-id", sampled: true })).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const injected = injectTraceContext({ Accept: "application/json" }, extracted!);
    expect(injected.traceparent).toBe(traceparent);
    expect(injected.tracestate).toBe("vendor=value");
    expect(injected.baggage).toBe("tenant=acme,user=ada%20lovelace");
    expect(injectBaggage({ baggage: "keep=1" }, { tenant: "acme" })).toEqual({ baggage: "keep=1" });
    expect(injectBaggage({ baggage: "keep=1" }, { tenant: "acme" }, { overwrite: true })).toEqual({ baggage: "tenant=acme" });
    expect(injectTraceContext({ TraceParent: "keep" }, extracted!)).toEqual({ TraceParent: "keep" });
  });

  it("seeds request runtimes from incoming trace headers and propagates outbound HTTP context", async () => {
    const incomingTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const incomingSpanId = "bbbbbbbbbbbbbbbb";
    const obs = makeObservability({ logs: false });
    const ctx = makeRequestObservabilityContext(obs, {
      method: "GET",
      route: "/users/:id",
      target: "/users/1",
      headers: {
        traceparent: `00-${incomingTraceId}-${incomingSpanId}-01`,
        tracestate: "vendor=value",
        baggage: "tenant=acme,request.id=req-1",
      },
    });
    const rt = ctx.makeRuntime();
    let captured: HttpRequest | undefined;

    const downstream: HttpClientFn = (req) => {
      captured = req;
      return asyncSucceed(ok());
    };
    const client = withHttpObservability(obs)(downstream);

    await expect(rt.toPromise(
      ctx.withRequestSpan(
        asyncFlatMap(
          client({ method: "GET", url: "https://downstream.example.test/users/1" }),
          () => asyncSucceed("handled")
        )
      )
    )).resolves.toBe("handled");
    await flushEvents();

    const outboundTrace = parseTraceparent(captured?.headers?.traceparent);
    expect(outboundTrace).toMatchObject({
      traceId: incomingTraceId,
      sampled: true,
    });
    expect(outboundTrace?.spanId).not.toBe(incomingSpanId);
    expect(captured?.headers?.tracestate).toBe("vendor=value");
    expect(captured?.headers?.baggage).toBe("request.id=req-1,tenant=acme");

    const spans = obs.tracer.exportFinished();
    const requestSpan = spans.find((span) => span.name === "GET /users/:id");
    const httpSpan = spans.find((span) => span.name === "HTTP GET");

    expect(ctx.trace).toMatchObject({ traceId: incomingTraceId, spanId: incomingSpanId, baggage: { tenant: "acme", "request.id": "req-1" } });
    expect(ctx.env.brass?.traceSeed).toMatchObject({ traceId: incomingTraceId, spanId: incomingSpanId, baggage: { tenant: "acme", "request.id": "req-1" } });
    expect(requestSpan).toBeDefined();
    expect(httpSpan).toBeDefined();
    expect(requestSpan).toMatchObject({
      traceId: incomingTraceId,
      parentSpanId: incomingSpanId,
      attrs: expect.objectContaining({
        "http.method": "GET",
        "http.route": "/users/:id",
        "http.target": "/users/1",
      }),
    });
    expect(httpSpan).toMatchObject({
      traceId: incomingTraceId,
      parentSpanId: requestSpan!.spanId,
      traceState: "vendor=value",
    });
  });
});
