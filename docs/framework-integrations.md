# Framework integrations

These recipes show how to wire Brass into common TypeScript application
frameworks without adding framework-specific dependencies to `brass-runtime`.

The common shape is:

- create one `Observability` instance near the application boundary;
- create one `Runtime` when framework handlers need to run effects;
- create one `makeDefaultHttpClient(...)` with `withHttpObservability(...)`;
- keep collector/vendor config in the application;
- shut down HTTP and observability queues from the host lifecycle when possible.

For browser apps, never expose Grafana Cloud tokens or collector secrets. Send
browser telemetry to a same-origin proxy such as `/api/otel`, then forward to
Grafana, Alloy, AppDynamics, or OpenTelemetry Collector from a trusted server.

## Recipes

| Framework | Recipe | Covers |
|-----------|--------|--------|
| Vanilla | [`docs/frameworks/vanilla.md`](./frameworks/vanilla.md) | Browser and Node setup without a framework |
| React | [`docs/frameworks/react.md`](./frameworks/react.md) | Context provider, hook, component usage |
| Next.js | [`docs/frameworks/nextjs.md`](./frameworks/nextjs.md) | App Router, server singleton, OTLP proxy |
| Angular | [`docs/frameworks/angular.md`](./frameworks/angular.md) | InjectionToken providers and services |
| Express | [`docs/frameworks/express.md`](./frameworks/express.md) | Request spans, `/metrics`, shutdown |
| Fastify | [`docs/frameworks/fastify.md`](./frameworks/fastify.md) | Request adapter, `/metrics`, shutdown |
| NestJS | [`docs/frameworks/nestjs.md`](./frameworks/nestjs.md) | Module providers, DI tokens, shutdown hooks |

Runnable dependency-optional examples live in:

- `src/examples/observabilityExpress.ts`
- `src/examples/observabilityFastify.ts`
- `src/examples/observabilityNest.ts`

See also [`docs/observability-framework-examples.md`](./observability-framework-examples.md)
for commands that run those examples locally.

