# Brass runtime examples

These examples are consumer apps that live in the repository only. They are not
included in the npm package because `package.json` publishes `dist`, `docs`,
`wasm/pkg`, and package metadata, but not the root `examples/` directory.

Each example wires the same Brass pieces in the style of its framework:

- Layer/DI or framework-native dependency injection.
- A production-shaped HTTP client with policy presets.
- Observability with Prometheus metrics and optional OTLP export.
- A fake transport so the example works offline.
- Graceful shutdown where the framework has a server lifecycle.

## Prerequisites

Build the local package entrypoints once before installing an example that
depends on `brass-runtime` through `file:../..`:

```bash
npm run build:ts
```

Then install and run a single example:

```bash
cd examples/express
npm install
npm run dev
```

## Examples

| Example | Focus |
| --- | --- |
| [vanilla](./vanilla/README.md) | Plain TypeScript service wiring with Brass Layer/DI |
| [express](./express/README.md) | Express middleware style, inbound request context, metrics endpoint |
| [nestjs](./nestjs/README.md) | Nest providers, controller injection, application shutdown |
| [nextjs](./nextjs/README.md) | App Router server singleton and same-origin OTLP proxy |
| [react](./react/README.md) | React context provider and browser-safe observability |
| [angular](./angular/README.md) | Angular `InjectionToken` providers and standalone component |
| [shared](./shared/README.md) | Shared fake transport, policy presets, config, and helpers |

## OTLP export

By default, examples use a local fake transport and do not send telemetry to an
external collector. To test real OTLP export in server examples, set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=my-service
```

Browser examples should send OTLP traffic to a same-origin backend route such
as `/api/otel`; do not ship collector credentials in client bundles.

