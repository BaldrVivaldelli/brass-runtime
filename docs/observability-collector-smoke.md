# Observability collector smoke

This smoke test sends one metric payload, one trace payload, and one log payload
to a real OpenTelemetry Collector over OTLP/HTTP.

Start the collector:

```bash
docker compose -f docker-compose.observability.yml up
```

In another shell:

```bash
npm run build:ts
npm run smoke:observability:collector
```

The collector config is `docs/otel-collector-smoke.yaml` and uses the debug
exporter, so accepted telemetry is printed in the collector logs.

Useful environment variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=brass-observability-smoke
BRASS_OBSERVABILITY_EXPORT_TIMEOUT_MS=5000
```

The smoke intentionally uses the public built package from `dist` so it checks
the same CJS/ESM package surface that users consume after a build.
