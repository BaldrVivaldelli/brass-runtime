# HTTP Server Recipe

Use `HttpServer` for the discoverable happy path: define routes, build a
router, and manage the Node listener as a resource.

```ts
import { asyncSucceed, runPromise, useResource } from "brass-runtime";
import { HttpServer, s } from "brass-runtime/http";

const User = s.object({
  id: s.int(),
  name: s.nonEmptyString(),
});

const routes = [
  HttpServer.route("GET", "/users/:id", {
    params: s.object({ id: s.int() }),
    response: User,
  }, (ctx) =>
    asyncSucceed(HttpServer.json({
      id: ctx.params.id,
      name: "Ada",
    })),
  ),
  HttpServer.healthRoute(),
  HttpServer.readinessRoute(),
];

const router = HttpServer.router(routes, {
  middleware: [HttpServer.middleware.header("x-powered-by", "brass-runtime")],
});

await runPromise(
  useResource(
    router.listen({ port: 3000 }),
    (server) => asyncSucceed(console.log(server.url())),
  ),
);
```

Validation failures are returned as JSON responses. Handler failures are mapped
to server error responses by the router, while listener failures use typed
`NodeHttpServerError` values.
