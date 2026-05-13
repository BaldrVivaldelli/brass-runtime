import { describe, expect, it } from "vitest";

import { asyncSucceed } from "../../core/types/asyncEffect";
import { Layer } from "../../core/runtime/layer";
import { Runtime } from "../../core/runtime/runtime";
import type { DefaultHttpClient } from "../defaultClient";
import type { HttpTransport } from "../transport";
import { HttpClientService, makeDefaultHttpClientLayer } from "../layer";
import {
  makeMockDefaultHttpClient,
  makeMockDefaultHttpClientLayer,
  makeMockHttpClient,
  runHttpEffect,
} from "../testing";

const transport: HttpTransport = ({ url }) =>
  asyncSucceed({
    status: 200,
    statusText: "OK",
    headers: {},
    bodyText: url.toString(),
    ms: 1,
  });

describe("HTTP Layer integration", () => {
  it("builds a default HTTP client from a LayerContext", async () => {
    const Config = Layer.tag<{ readonly baseUrl: string }>("Config");
    const runtime = Runtime.make({});

    const AppLayer = Layer.composeAll(
      Layer.value(Config, { baseUrl: "https://api.example.com" }),
      makeDefaultHttpClientLayer((ctx) => ({
        baseUrl: ctx.unsafeGet(Config).baseUrl,
        preset: "minimal",
        transport,
      })),
    );

    await expect(runtime.toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.use(HttpClientService, (http) => http.getText("/users/42")),
      ),
    )).resolves.toMatchObject({
      body: "https://api.example.com/users/42",
      status: 200,
    });
  });

  it("supports custom service tags for multiple clients", async () => {
    const OrdersHttp = Layer.tag<DefaultHttpClient>("OrdersHttp");
    const runtime = Runtime.make({});

    const AppLayer = makeDefaultHttpClientLayer({
      baseUrl: "https://orders.example.com",
      preset: "minimal",
      transport,
    }, { tag: OrdersHttp });

    await expect(runtime.toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.use(OrdersHttp, (http) => http.getText("/orders/1")),
      ),
    )).resolves.toMatchObject({
      body: "https://orders.example.com/orders/1",
      status: 200,
    });
  });

  it("provides a mock default client as a test layer", async () => {
    const runtime = Runtime.make({});
    const wire = makeMockHttpClient();

    await expect(runHttpEffect(wire({ method: "GET", url: "/wire" }))).resolves.toMatchObject({
      status: 200,
    });
    expect(wire.calls()).toHaveLength(1);
    expect(wire.calledTimes()).toBe(1);
    expect(wire.lastRequest()).toMatchObject({ url: "/wire" });
    wire.reset();
    expect(wire.calledTimes()).toBe(0);

    const defaultHttp = makeMockDefaultHttpClient();
    await expect(runtime.toPromise(defaultHttp.getText("/default"))).resolves.toMatchObject({
      status: 200,
    });
    expect(defaultHttp.calledTimes()).toBe(1);
    expect(defaultHttp.lastRequest()).toMatchObject({ url: "/default" });
    defaultHttp.reset();
    expect(defaultHttp.calledTimes()).toBe(0);

    expect(makeMockDefaultHttpClientLayer()).toMatchObject({ _tag: "Layer" });

    const AppLayer = makeMockDefaultHttpClientLayer((req) => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ url: req.url }),
      ms: 1,
    }));

    await expect(runtime.toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.use(HttpClientService, (http) => http.getJson<{ readonly url: string }>("/users/1")),
      ),
    )).resolves.toMatchObject({
      body: { url: "/users/1" },
      status: 200,
    });
  });
});
