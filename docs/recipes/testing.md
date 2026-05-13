# Testing Recipe

Use `makeTestRuntime` for deterministic clocks and scheduler control.

```ts
import { asyncFlatMap, asyncSucceed, sleep, timeout } from "brass-runtime";
import { makeTestRuntime } from "brass-runtime";

const test = makeTestRuntime();

const program = asyncFlatMap(sleep(1000), () => asyncSucceed("done"));

const result = test.run(program);
await test.advance(1000);

console.log(await result); // done
```

Use HTTP testing helpers for client code without touching the network.

```ts
import {
  makeJsonHttpResponse,
  makeMockHttpClient,
  runHttpEffect,
} from "brass-runtime/http/testing";

const client = makeMockHttpClient((req) =>
  makeJsonHttpResponse({ ok: true, url: req.url }),
);

const response = await runHttpEffect(client({ method: "GET", url: "/health" }));
console.log(response.status);
```

Layer-based applications can swap services with `makeTestLayer`,
`makeTestLayers`, or a mock default HTTP client layer:

```ts
import { Layer, makeTestLayer } from "brass-runtime/core";
import { HttpClientService } from "brass-runtime/http";
import {
  makeJsonHttpResponse,
  makeMockDefaultHttpClientLayer,
} from "brass-runtime/http/testing";

const Config = Layer.tag<{ readonly baseUrl: string }>("Config");

const TestLayer = Layer.composeAll(
  makeTestLayer(Config, { baseUrl: "test://users" }),
  makeMockDefaultHttpClientLayer((req) =>
    makeJsonHttpResponse({ url: req.url }),
  ),
);

const program = Layer.use(HttpClientService, (http) =>
  http.getJson("/users/1"),
);
```

For typed failures, assert on `Exit` instead of catching thrown values.

```ts
const exit = await test.runExit(timeout(asyncSucceed("ok"), 1));
console.log(exit._tag);
```
