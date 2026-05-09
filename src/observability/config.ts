import {
  makeObservability,
  type Observability,
  type ObservabilityOptions,
  type ObservabilityOtlpOptions,
} from "./setup";

export type ObservabilityPreset = "development" | "production" | "test" | "disabled";

export type ObservabilityEnv = Record<string, string | undefined>;

export function makeNoopObservability(): Observability {
  return makeObservability({
    metrics: false,
    logs: false,
    traces: false,
    autoStart: false,
  });
}

export function makeObservabilityPreset(
  preset: ObservabilityPreset,
  overrides: ObservabilityOptions = {}
): Observability {
  if (preset === "disabled") return makeNoopObservability();
  return makeObservability(mergeObservabilityOptions(observabilityOptionsForPreset(preset), overrides));
}

export function makeObservabilityFromEnv(
  env: ObservabilityEnv = readProcessEnv(),
  overrides: ObservabilityOptions = {}
): Observability {
  const preset = env.BRASS_OBSERVABILITY === "disabled"
    ? "disabled"
    : parsePreset(env.BRASS_OBSERVABILITY_PRESET ?? env.NODE_ENV);

  if (preset === "disabled") return makeNoopObservability();
  return makeObservability(mergeObservabilityOptions(observabilityOptionsFromEnv(env, preset), overrides));
}

export function observabilityOptionsForPreset(preset: Exclude<ObservabilityPreset, "disabled">): ObservabilityOptions {
  switch (preset) {
    case "production":
      return {
        logs: { minLevel: "info" },
        sampling: { ratio: 1, respectRemoteSampled: true, forceSampleOnError: true },
        redaction: {},
        cardinality: { maxValuesPerLabel: 100 },
        otlp: {
          timeoutMs: 10_000,
          retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 2_000 },
          pipeline: {
            maxQueueSize: 10_000,
            batchSize: 512,
            dropPolicy: "drop-oldest",
            shutdownTimeoutMs: 10_000,
          },
        },
        flushIntervalMs: 10_000,
        autoStart: true,
      };

    case "test":
      return {
        logs: false,
        sampling: 1,
        redaction: {},
        otlp: {
          timeoutMs: 1_000,
          retry: { attempts: 1 },
          pipeline: { maxQueueSize: 1_000, batchSize: 256, shutdownTimeoutMs: 1_000 },
        },
        autoStart: false,
      };

    case "development":
      return {
        logs: { minLevel: "debug" },
        sampling: 1,
        redaction: {},
        cardinality: { maxValuesPerLabel: 100 },
        autoStart: false,
      };
  }
}

export function observabilityOptionsFromEnv(
  env: ObservabilityEnv = readProcessEnv(),
  preset: Exclude<ObservabilityPreset, "disabled"> = parsePreset(env.BRASS_OBSERVABILITY_PRESET ?? env.NODE_ENV)
): ObservabilityOptions {
  const base = observabilityOptionsForPreset(preset);
  const serviceName = env.OTEL_SERVICE_NAME ?? env.BRASS_SERVICE_NAME;
  const serviceVersion = env.OTEL_SERVICE_VERSION ?? env.BRASS_SERVICE_VERSION;
  const endpoint = trimTrailingSlash(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const metricsUrl = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? (endpoint ? `${endpoint}/v1/metrics` : undefined);
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (endpoint ? `${endpoint}/v1/traces` : undefined);
  const logsUrl = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? (endpoint ? `${endpoint}/v1/logs` : undefined);
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const flushIntervalMs = parsePositiveInt(env.BRASS_OBSERVABILITY_FLUSH_INTERVAL_MS);
  const timeoutMs = parsePositiveInt(env.BRASS_OBSERVABILITY_EXPORT_TIMEOUT_MS);
  const sampleRatio = parseRatio(env.BRASS_TRACE_SAMPLE_RATIO ?? env.OTEL_TRACES_SAMPLER_ARG);
  const minLevel = env.BRASS_OBSERVABILITY_LOG_LEVEL;

  const otlp: ObservabilityOtlpOptions = {
    ...(base.otlp ?? {}),
    ...(metricsUrl ? { metricsUrl } : {}),
    ...(tracesUrl ? { tracesUrl } : {}),
    ...(logsUrl ? { logsUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };

  return mergeObservabilityOptions(base, {
    ...(serviceName ? { serviceName } : {}),
    ...(serviceVersion ? { serviceVersion } : {}),
    ...(Object.keys(otlp).length > 0 ? { otlp } : {}),
    ...(flushIntervalMs ? { flushIntervalMs, autoStart: true } : {}),
    ...(sampleRatio !== undefined ? { sampling: { ratio: sampleRatio, respectRemoteSampled: true, forceSampleOnError: true } } : {}),
    ...(minLevel === "debug" || minLevel === "info" || minLevel === "warn" || minLevel === "error"
      ? { logs: { minLevel } }
      : {}),
  });
}

function mergeObservabilityOptions(base: ObservabilityOptions, overrides: ObservabilityOptions): ObservabilityOptions {
  return {
    ...base,
    ...overrides,
    metrics: overrides.metrics ?? base.metrics,
    logs: overrides.logs ?? base.logs,
    otlp: {
      ...(base.otlp ?? {}),
      ...(overrides.otlp ?? {}),
      retry: overrides.otlp?.retry ?? base.otlp?.retry,
      pipeline: {
        ...(base.otlp?.pipeline ?? {}),
        ...(overrides.otlp?.pipeline ?? {}),
      },
    },
  };
}

function parsePreset(value: string | undefined): Exclude<ObservabilityPreset, "disabled"> {
  if (value === "production" || value === "prod") return "production";
  if (value === "test") return "test";
  return "development";
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const headerValue = part.slice(index + 1).trim();
    if (key) out[key] = headerValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRatio(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out || undefined;
}

function readProcessEnv(): ObservabilityEnv {
  return typeof process !== "undefined" ? process.env : {};
}
