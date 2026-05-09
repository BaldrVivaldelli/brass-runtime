# Observability framework examples

These examples show how to seed Brass runtime traces from inbound HTTP headers,
create a request span, emit structured logs, expose Prometheus metrics, and
flush OTLP metrics/traces.

They use optional framework dependencies so the runtime package does not force
Express, Fastify, or Nest into normal installs.

## Express

```bash
npm install --save-dev express
npm run example:observability:express
```

Try it:

```bash
curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' \
  http://localhost:3000/users/42

curl http://localhost:3000/metrics
```

Source: `src/examples/observabilityExpress.ts`.

## Fastify

```bash
npm install --save-dev fastify
npm run example:observability:fastify
```

Try it:

```bash
curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' \
  http://localhost:3001/users/42

curl http://localhost:3001/metrics
```

Source: `src/examples/observabilityFastify.ts`.

## Nest

```bash
npm install --save-dev @nestjs/core @nestjs/common @nestjs/platform-express reflect-metadata rxjs
npm run example:observability:nest
```

Try it:

```bash
curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' \
  http://localhost:3002/users/42

curl http://localhost:3002/metrics
```

Source: `src/examples/observabilityNest.ts`.

## What the examples demonstrate

- `makeObservabilityFromEnv(process.env)` for deployment-style setup.
- Framework-specific request adapters:
  - `makeExpressRequestObservabilityContext`
  - `makeFastifyRequestObservabilityContext`
- W3C `traceparent` extraction from inbound headers.
- `ctx.withRequestSpan(...)` around request work.
- `logEffect(...)` with redaction of sensitive fields like `authorization`.
- `/metrics` endpoint using the Prometheus exporter.
- OTLP export through a fake local `fetch` that prints payload sizes.

## Benchmark

Run only the observability overhead benchmark:

```bash
npm run benchmark:observability
npm run benchmark:observability:budget
```

Or include it in the full benchmark suite:

```bash
npm run benchmark
```

The benchmark source is `src/benchmarks/observability-overhead.bench.ts` and
measures:

- baseline `asyncSucceed`
- `withSpan` start/end overhead
- `logEffect` structured sink overhead
- composed span + event + log overhead
- OTLP trace flush for 25 spans
