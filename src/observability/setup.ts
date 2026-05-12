import { EventBus } from "../core/runtime/eventBus";
import type { BrassEnv, Tracer as RuntimeTraceIdGenerator } from "../core/runtime/tracer";
import type { Baggage, TraceContext } from "../core/runtime/contex";
import { makeMetrics, type MetricsRegistry } from "../core/runtime/metrics";
import { InMemoryTracer, type InMemoryTracerOptions, type RuntimeSpan } from "../core/runtime/tracingSink";
import type { RuntimeHooks } from "../core/runtime/events";
import {
  makeOtlpHttpMetricsExporter,
  makePrometheusMetricsExporter,
  makeRuntimeMetricsSink,
  postOtlpJson,
  type OtlpAttributeValue,
  type OtlpFetch,
  type OtlpHttpExportResult,
  type PrometheusMetricsExporter,
  type PrometheusMetricsOptions,
  type RuntimeMetricsSinkOptions,
} from "./metrics";
import {
  defaultStructuredLogWriter,
  makeStructuredLogSink,
  structuredLogsToOtlp,
  type StructuredLogRecord,
  type StructuredLogSinkOptions,
} from "./logs";
import { spansToOtlp } from "./traces";
import { extractBaggage, extractTraceContext, parseBaggage, parseTraceparent, type TraceContextCarrier } from "./traceContext";
import {
  exportWithRetry,
  makeExportPipeline,
  withTimeout,
  type ExportPipeline,
  type ExportPipelineTuning,
  type ExportRetryOptions,
} from "./exportPipeline";
import { makeObservabilityRedactor, type RedactionConfig } from "./redaction";
import { makeCardinalityLimitedMetrics, type CardinalityConfig } from "./cardinality";
import { resolveTraceSampling, type TraceSamplingConfig } from "./sampling";
import { validateObservabilityOptions } from "./configValidation";
import { snapshotRuntimeHealth, type RuntimeHealthOptions, type RuntimeHealthReport } from "./health";

export type ObservabilityOtlpOptions = {
  readonly metricsUrl?: string;
  readonly tracesUrl?: string;
  readonly logsUrl?: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: OtlpFetch;
  readonly timeoutMs?: number;
  readonly retry?: ExportRetryOptions;
  readonly pipeline?: ExportPipelineTuning;
};

export type ObservabilityOtlpSignal = "metrics" | "traces" | "logs";

export type MakeOtlpOptionsInput = {
  readonly endpoint: string;
  readonly headers?: ObservabilityOtlpOptions["headers"];
  readonly fetch?: ObservabilityOtlpOptions["fetch"];
  readonly timeoutMs?: ObservabilityOtlpOptions["timeoutMs"];
  readonly retry?: ObservabilityOtlpOptions["retry"];
  readonly pipeline?: ObservabilityOtlpOptions["pipeline"];
  readonly signals?: readonly ObservabilityOtlpSignal[];
};

const DEFAULT_OTLP_SIGNALS: readonly ObservabilityOtlpSignal[] = ["metrics", "traces", "logs"];

export function makeOtlpOptions(input: MakeOtlpOptionsInput): ObservabilityOtlpOptions {
  const endpoint = normalizeOtlpEndpoint(input.endpoint);
  const signals = input.signals ?? DEFAULT_OTLP_SIGNALS;

  return {
    ...(signals.includes("metrics") ? { metricsUrl: `${endpoint}/v1/metrics` } : {}),
    ...(signals.includes("traces") ? { tracesUrl: `${endpoint}/v1/traces` } : {}),
    ...(signals.includes("logs") ? { logsUrl: `${endpoint}/v1/logs` } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
    ...(input.pipeline ? { pipeline: input.pipeline } : {}),
  };
}

export type ObservabilityOptions = {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly resource?: Record<string, OtlpAttributeValue>;
  readonly eventBus?: EventBus;
  readonly metrics?: false | (RuntimeMetricsSinkOptions & {
    readonly prometheus?: PrometheusMetricsOptions;
  });
  readonly logs?: false | StructuredLogSinkOptions;
  readonly traces?: false | Omit<InMemoryTracerOptions, "sanitizeAttributes" | "sanitizeError">;
  readonly sampling?: TraceSamplingConfig;
  readonly redaction?: RedactionConfig;
  readonly cardinality?: CardinalityConfig;
  readonly otlp?: ObservabilityOtlpOptions;
  readonly flushIntervalMs?: number;
  readonly autoStart?: boolean;
  readonly traceSeed?: TraceContext;
  readonly childName?: (parentName?: string) => string | undefined;
  readonly onFlushError?: (error: unknown, signal: "metrics" | "traces" | "logs") => void;
};

export type ObservabilityRequestEnvInput =
  | TraceContextCarrier
  | {
    readonly headers?: TraceContextCarrier;
    readonly trace?: TraceContext;
    readonly traceparent?: string;
    readonly tracestate?: string;
    readonly baggage?: Baggage | string;
  };

export type ObservabilityFlushError = {
  readonly signal: "metrics" | "traces" | "logs";
  readonly error: unknown;
};

export type ObservabilityTraceExportResult = OtlpHttpExportResult & {
  readonly spanCount: number;
};

export type ObservabilityLogExportResult = OtlpHttpExportResult & {
  readonly logCount: number;
};

export type ObservabilityFlushResult = {
  readonly metrics?: OtlpHttpExportResult;
  readonly traces?: ObservabilityTraceExportResult;
  readonly logs?: ObservabilityLogExportResult;
  readonly errors: readonly ObservabilityFlushError[];
};

export type ObservabilityExporters = {
  readonly prometheus: PrometheusMetricsExporter;
  readonly otlpMetrics?: {
    readonly export: () => Promise<OtlpHttpExportResult>;
  };
  readonly otlpTraces?: {
    readonly export: () => Promise<ObservabilityTraceExportResult>;
    readonly pipeline: ExportPipeline<RuntimeSpan>;
  };
  readonly otlpLogs?: {
    readonly export: () => Promise<ObservabilityLogExportResult>;
    readonly pipeline: ExportPipeline<StructuredLogRecord>;
  };
};

export type ObservabilityRuntimeEnv = BrassEnv;

export type Observability = {
  readonly hooks: EventBus;
  readonly eventBus: EventBus;
  readonly env: ObservabilityRuntimeEnv;
  readonly envForRequest: (input?: ObservabilityRequestEnvInput) => ObservabilityRuntimeEnv;
  readonly metrics: MetricsRegistry;
  readonly tracer: InMemoryTracer;
  readonly traceIdGenerator: RuntimeTraceIdGenerator;
  readonly exporters: ObservabilityExporters;
  readonly prometheus: PrometheusMetricsExporter;
  readonly health: (options?: Omit<RuntimeHealthOptions, "metrics">) => RuntimeHealthReport;
  readonly readiness: (options?: Omit<RuntimeHealthOptions, "metrics">) => boolean;
  readonly flush: () => Promise<ObservabilityFlushResult>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly shutdown: () => Promise<ObservabilityFlushResult>;
};

function normalizeOtlpEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");

  if (!withoutTrailingSlash) {
    throw new Error("makeOtlpOptions endpoint must not be empty");
  }

  return withoutTrailingSlash;
}

export function makeObservability(options: ObservabilityOptions = {}): Observability {
  validateObservabilityOptions(options);

  const serviceName = options.serviceName ?? "brass-runtime";
  const eventBus = options.eventBus ?? new EventBus();
  const rawMetrics = makeMetrics();
  const metrics = options.cardinality === false
    ? rawMetrics
    : makeCardinalityLimitedMetrics(rawMetrics, options.cardinality ?? {});
  const redactor = makeObservabilityRedactor(options.redaction);
  const traceOptions = options.traces && typeof options.traces === "object" ? options.traces : {};
  const tracer = new InMemoryTracer({
    maxFinishedSpans: traceOptions.maxFinishedSpans ?? 10_000,
    maxSpanAgeMs: traceOptions.maxSpanAgeMs ?? 10 * 60_000,
    clock: traceOptions.clock,
    sanitizeAttributes: redactor.attributes,
    sanitizeError: redactor.value,
  });
  const traceIdGenerator = makeRuntimeTraceIdGenerator();
  const sampling = resolveTraceSampling(options.traces === false ? false : options.sampling);
  const makeEnv = (traceSeed?: TraceContext, baggage?: Baggage): ObservabilityRuntimeEnv => ({
    brass: {
      tracer: traceIdGenerator,
      ...(traceSeed ? { traceSeed: baggage ? { ...traceSeed, baggage: { ...(traceSeed.baggage ?? {}), ...baggage } } : traceSeed } : {}),
      ...(!traceSeed && baggage ? { baggage } : {}),
      sampler: sampling.sampler,
      respectRemoteSampled: sampling.respectRemoteSampled,
      forceSampleOnError: sampling.forceSampleOnError,
      childName: options.childName,
    },
  });
  const env = makeEnv(options.traceSeed, options.traceSeed?.baggage);
  const envForRequest = (input?: ObservabilityRequestEnvInput) =>
    makeEnv(resolveRequestTraceSeed(input) ?? options.traceSeed, resolveRequestBaggage(input));
  const resource = {
    "service.name": serviceName,
    ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
    ...(options.resource ?? {}),
  };

  if (options.metrics !== false) {
    const { prometheus: _prometheus, ...metricsOptions } = options.metrics ?? {};
    eventBus.subscribeHooks(makeRuntimeMetricsSink(metrics, metricsOptions));
  }

  const logPipeline = options.logs !== false && options.otlp?.logsUrl
    ? makeExportPipeline<StructuredLogRecord>({
      signal: "logs",
      metrics,
      ...(options.otlp.pipeline ?? {}),
      timeoutMs: options.otlp.timeoutMs ?? options.otlp.pipeline?.timeoutMs,
      retry: options.otlp.retry ?? options.otlp.pipeline?.retry,
      exportBatch: async (records) => {
        const body = JSON.stringify(structuredLogsToOtlp(records, {
          resource,
          scopeName: serviceName,
          scopeVersion: options.serviceVersion,
        }));
        const response = await postOtlpJson({
          url: options.otlp!.logsUrl!,
          headers: options.otlp!.headers,
          fetch: options.otlp!.fetch,
        }, body);
        return { status: response.status, body };
      },
    })
    : undefined;

  if (options.logs !== false) {
    const configuredLogs = options.logs ?? {};
    const configuredWrite = configuredLogs.write;
    eventBus.subscribeHooks(makeStructuredLogSink({
      ...configuredLogs,
      redact: options.logs && options.logs.redact !== undefined ? options.logs.redact : redactor,
      write: (record) => {
        if (configuredWrite) configuredWrite(record);
        else defaultStructuredLogWriter(record);
        logPipeline?.enqueue([record]);
      },
    }));
  }

  if (options.traces !== false) {
    eventBus.subscribeHooks(tracer);
  }

  const prometheus = makePrometheusMetricsExporter(metrics, options.metrics !== false ? options.metrics?.prometheus : undefined);
  const otlpMetrics = options.otlp?.metricsUrl
    ? makeOtlpHttpMetricsExporter(metrics, {
      url: options.otlp.metricsUrl,
      headers: options.otlp.headers,
      fetch: options.otlp.fetch,
      resource,
      scopeName: serviceName,
      scopeVersion: options.serviceVersion,
    })
    : undefined;
  const otlpMetricsExporter = otlpMetrics
    ? {
      export: async (): Promise<OtlpHttpExportResult> => {
        const result = await exportWithRetry(
          () => withTimeout(() => otlpMetrics.export(), options.otlp?.timeoutMs ?? 10_000),
          {
            signal: "metrics",
            metrics,
            retry: options.otlp?.retry,
          }
        );
        return result.value;
      },
    }
    : undefined;

  const exportedSpanIds = new Set<string>();
  const queuedSpanIds = new Set<string>();
  const pendingSpans = () => tracer.exportFinished().filter((span) => !exportedSpanIds.has(span.spanId) && !queuedSpanIds.has(span.spanId));
  const tracePipeline = options.otlp?.tracesUrl
    ? makeExportPipeline<RuntimeSpan>({
      signal: "traces",
      metrics,
      ...(options.otlp.pipeline ?? {}),
      timeoutMs: options.otlp.timeoutMs ?? options.otlp.pipeline?.timeoutMs,
      retry: options.otlp.retry ?? options.otlp.pipeline?.retry,
      exportBatch: async (spans) => {
        const body = JSON.stringify(spansToOtlp(spans, {
          resource,
          scopeName: serviceName,
          scopeVersion: options.serviceVersion,
        }));
        const response = await postOtlpJson({
          url: options.otlp!.tracesUrl!,
          headers: options.otlp!.headers,
          fetch: options.otlp!.fetch,
        }, body);

        const spanIds = spans.map((span) => span.spanId);
        for (const spanId of spanIds) {
          exportedSpanIds.add(spanId);
          queuedSpanIds.delete(spanId);
        }
        tracer.pruneFinished(spanIds);
        for (const spanId of spanIds) exportedSpanIds.delete(spanId);
        return { status: response.status, body };
      },
      onDrop: (spans) => {
        const spanIds = spans.map((span) => span.spanId);
        for (const spanId of spanIds) {
          queuedSpanIds.delete(spanId);
          exportedSpanIds.add(spanId);
        }
        tracer.pruneFinished(spanIds);
        for (const spanId of spanIds) exportedSpanIds.delete(spanId);
      },
    })
    : undefined;
  const otlpTraces = options.otlp?.tracesUrl
    ? {
      pipeline: tracePipeline!,
      export: async (): Promise<ObservabilityTraceExportResult> => {
        const spans = pendingSpans();
        for (const span of spans) queuedSpanIds.add(span.spanId);
        tracePipeline!.enqueue(spans);

        if (tracePipeline!.stats().queueSize === 0) {
          return { status: undefined, body: "", spanCount: 0 };
        }

        const result = await tracePipeline!.flush();
        if (result.errors.length > 0) throw result.errors[0];
        return {
          status: result.status,
          body: result.body ?? "",
          spanCount: result.exported,
        };
      },
    }
    : undefined;
  const otlpLogs = logPipeline
    ? {
      pipeline: logPipeline,
      export: async (): Promise<ObservabilityLogExportResult> => {
        if (logPipeline.stats().queueSize === 0) {
          return { status: undefined, body: "", logCount: 0 };
        }

        const result = await logPipeline.flush();
        if (result.errors.length > 0) throw result.errors[0];
        return {
          status: result.status,
          body: result.body ?? "",
          logCount: result.exported,
        };
      },
    }
    : undefined;

  let interval: ReturnType<typeof setInterval> | undefined;

  const flushNow = async (): Promise<ObservabilityFlushResult> => {
    eventBus.flush();
    const errors: ObservabilityFlushError[] = [];
    let metricsResult: OtlpHttpExportResult | undefined;
    let tracesResult: ObservabilityTraceExportResult | undefined;
    let logsResult: ObservabilityLogExportResult | undefined;

    if (otlpMetricsExporter) {
      try {
        metricsResult = await otlpMetricsExporter.export();
      } catch (error) {
        errors.push({ signal: "metrics", error });
        options.onFlushError?.(error, "metrics");
      }
    }

    if (otlpTraces) {
      try {
        tracesResult = await otlpTraces.export();
      } catch (error) {
        errors.push({ signal: "traces", error });
        options.onFlushError?.(error, "traces");
      }
    }

    if (otlpLogs) {
      try {
        logsResult = await otlpLogs.export();
      } catch (error) {
        errors.push({ signal: "logs", error });
        options.onFlushError?.(error, "logs");
      }
    }

    return { metrics: metricsResult, traces: tracesResult, logs: logsResult, errors };
  };
  let inFlightFlush: Promise<ObservabilityFlushResult> | undefined;

  const flush = (): Promise<ObservabilityFlushResult> => {
    if (inFlightFlush) {
      metrics.counter("brass_export_flush_singleflight_total").increment();
      return inFlightFlush;
    }

    inFlightFlush = flushNow().finally(() => {
      inFlightFlush = undefined;
    });
    return inFlightFlush;
  };

  const start = () => {
    if (interval || !options.flushIntervalMs || options.flushIntervalMs <= 0) return;
    interval = setInterval(() => {
      void flush();
    }, options.flushIntervalMs);
    (interval as any).unref?.();
  };

  const stop = () => {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  };

  const shutdown = async () => {
    stop();
    const result = await flush();
    const drainErrors: ObservabilityFlushError[] = [];
    let traces = result.traces;
    let logs = result.logs;

    if (tracePipeline && tracePipeline.stats().queueSize > 0) {
      const drain = await tracePipeline.shutdown(options.otlp?.pipeline?.shutdownTimeoutMs);
      for (const error of drain.errors) {
        drainErrors.push({ signal: "traces", error });
        options.onFlushError?.(error, "traces");
      }
      traces = traces ?? {
        status: drain.status,
        body: drain.body ?? "",
        spanCount: drain.exported,
      };
    }

    if (logPipeline && logPipeline.stats().queueSize > 0) {
      const drain = await logPipeline.shutdown(options.otlp?.pipeline?.shutdownTimeoutMs);
      for (const error of drain.errors) {
        drainErrors.push({ signal: "logs", error });
        options.onFlushError?.(error, "logs");
      }
      logs = logs ?? {
        status: drain.status,
        body: drain.body ?? "",
        logCount: drain.exported,
      };
    }

    if (drainErrors.length === 0 && traces === result.traces && logs === result.logs) return result;
    return {
      ...result,
      traces,
      logs,
      errors: [...result.errors, ...drainErrors],
    };
  };

  if (options.autoStart ?? Boolean(options.flushIntervalMs)) {
    start();
  }

  return {
    hooks: eventBus,
    eventBus,
    env,
    envForRequest,
    metrics,
    tracer,
    traceIdGenerator,
    exporters: {
      prometheus,
      otlpMetrics: otlpMetricsExporter,
      otlpTraces,
      otlpLogs,
    },
    prometheus,
    health: (healthOptions = {}) => snapshotRuntimeHealth({ ...healthOptions, metrics }),
    readiness: (healthOptions = {}) => snapshotRuntimeHealth({ ...healthOptions, metrics }).ready,
    flush,
    start,
    stop,
    shutdown,
  };
}

export function resolveRequestTraceSeed(input?: ObservabilityRequestEnvInput): TraceContext | undefined {
  if (!input) return undefined;

  if (isTraceContext(input)) return input;

  const maybeRequest = input as {
    readonly headers?: TraceContextCarrier;
    readonly trace?: TraceContext;
    readonly traceparent?: string;
    readonly tracestate?: string;
    readonly baggage?: Baggage | string;
  };

  const explicitBaggage = typeof maybeRequest.baggage === "string"
    ? parseBaggage(maybeRequest.baggage)
    : maybeRequest.baggage;

  if (maybeRequest.trace) {
    return {
      ...maybeRequest.trace,
      ...(explicitBaggage ? { baggage: { ...(maybeRequest.trace.baggage ?? {}), ...explicitBaggage } } : {}),
    };
  }
  if (maybeRequest.traceparent) {
    const trace = parseTraceparent(maybeRequest.traceparent);
    return trace
      ? {
        ...trace,
        ...(maybeRequest.tracestate ? { traceState: maybeRequest.tracestate } : {}),
        ...(explicitBaggage ? { baggage: explicitBaggage } : {}),
      }
      : undefined;
  }
  if (maybeRequest.headers) {
    const trace = extractTraceContext(maybeRequest.headers);
    return trace && explicitBaggage
      ? { ...trace, baggage: { ...(trace.baggage ?? {}), ...explicitBaggage } }
      : trace;
  }

  return extractTraceContext(input as TraceContextCarrier);
}

export function resolveRequestBaggage(input?: ObservabilityRequestEnvInput): Baggage | undefined {
  if (!input) return undefined;
  if (isTraceContext(input)) return input.baggage;

  const maybeRequest = input as {
    readonly headers?: TraceContextCarrier;
    readonly trace?: TraceContext;
    readonly baggage?: Baggage | string;
  };
  if (typeof maybeRequest.baggage === "string") return parseBaggage(maybeRequest.baggage);
  if (maybeRequest.baggage) return maybeRequest.baggage;
  if (maybeRequest.trace?.baggage) return maybeRequest.trace.baggage;
  if (maybeRequest.headers) return extractBaggage(maybeRequest.headers);
  return extractBaggage(input as TraceContextCarrier);
}

function isTraceContext(value: unknown): value is TraceContext {
  return typeof value === "object"
    && value !== null
    && typeof (value as TraceContext).traceId === "string"
    && typeof (value as TraceContext).spanId === "string";
}

function makeRuntimeTraceIdGenerator(): RuntimeTraceIdGenerator {
  return {
    newTraceId: () => randomHexId(32),
    newSpanId: () => randomHexId(16),
  };
}

const HEX_BYTE = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

function randomHexId(length: number): string {
  const cryptoLike = (globalThis as any).crypto;

  if (typeof cryptoLike?.getRandomValues === "function") {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    cryptoLike.getRandomValues(bytes);
    return bytesToHex(bytes, length);
  }

  if (typeof cryptoLike?.randomUUID === "function") {
    const hex = cryptoLike.randomUUID().replace(/-/g, "");
    if (hex.length >= length) return hex.slice(0, length);
  }

  let out = "";
  while (out.length < length) {
    out += Math.floor(Math.random() * 0xffff_ffff).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function bytesToHex(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_BYTE[bytes[i]!]!;
  }
  return out.length === length ? out : out.slice(0, length);
}
