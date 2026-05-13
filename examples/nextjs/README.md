# Next.js example

Next.js uses a server-only Brass singleton for Route Handlers. The example also
includes a same-origin OTLP proxy route shape for browser telemetry.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/nextjs
npm install
npm run dev
```

Open:

```txt
http://localhost:3000
http://localhost:3000/api/users/42
```

To proxy real OTLP traffic from `/api/otel/v1/*`, set:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

