import type { RuntimeEvent, RuntimeHooks } from "../core/runtime/events";
import type { MetricExemplar, MetricSnapshot, MetricsRegistry } from "../core/runtime/metrics";
import type { TraceContext } from "../core/runtime/contex";
import { normalizeSpanId, normalizeTraceId } from "./traceContext";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const OTLP_JSON_CONTENT_TYPE = "application/json";

export type PrometheusMetricsOptions = {
  readonly prefix?: string;
  readonly includeTimestamp?: boolean;
  readonly includeExemplars?: boolean;
  readonly help?: Record<string, string>;
  readonly now?: () => number;
};

export type PrometheusMetricsExporter = {
  readonly contentType: string;
  readonly export: () => string;
};

export type OtlpAttributeValue = string | number | boolean;

export type OtlpExportOptions = {
  readonly resource?: Record<string, OtlpAttributeValue>;
  readonly scopeName?: string;
  readonly scopeVersion?: string;
  readonly now?: () => number;
};

export type OtlpHttpResponse = {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly text?: () => Promise<string>;
};

export type OtlpFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
  }
) => Promise<OtlpHttpResponse>;

export type OtlpHttpExporterOptions = OtlpExportOptions & {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: OtlpFetch;
};

export type OtlpHttpExportResult = {
  readonly status?: number;
  readonly body: string;
};

export type RuntimeMetricsSinkOptions = {
  readonly durationBuckets?: readonly number[];
  readonly clock?: () => number;
  readonly includeEventTotals?: boolean;
  readonly includeSpanNameLabel?: boolean;
};

const DEFAULT_DURATION_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function makePrometheusMetricsExporter(
  registry: MetricsRegistry,
  options: PrometheusMetricsOptions = {}
): PrometheusMetricsExporter {
  return {
    contentType: PROMETHEUS_CONTENT_TYPE,
    export: () => formatPrometheusMetrics(registry.snapshot(), options),
  };
}

export function formatPrometheusMetrics(snapshot: MetricSnapshot, options: PrometheusMetricsOptions = {}): string {
  const lines: string[] = [];
  const emittedHeaders = new Set<string>();
  const now = Math.trunc(options.now?.() ?? Date.now());

  const metricName = (name: string) => sanitizeMetricName(`${options.prefix ?? ""}${name}`);

  const emitHeader = (name: string, type: "counter" | "gauge" | "histogram") => {
    const safeName = metricName(name);
    const key = `${safeName}:${type}`;
    if (emittedHeaders.has(key)) return;
    emittedHeaders.add(key);
    if (options.help?.[name]) lines.push(`# HELP ${safeName} ${escapeHelp(options.help[name]!)}`);
    lines.push(`# TYPE ${safeName} ${type}`);
  };

  const emitSample = (name: string, labels: Record<string, string>, value: number, exemplar?: MetricExemplar) => {
    const exemplarSuffix = options.includeExemplars && exemplar ? formatExemplar(exemplar) : "";
    const suffix = exemplarSuffix || !options.includeTimestamp ? exemplarSuffix : ` ${now}`;
    lines.push(`${metricName(name)}${formatLabels(labels)} ${formatNumber(value)}${suffix}`);
  };

  for (const counter of snapshot.counters) {
    emitHeader(counter.name, "counter");
    emitSample(counter.name, counter.labels, counter.value);
  }

  for (const gauge of snapshot.gauges) {
    emitHeader(gauge.name, "gauge");
    emitSample(gauge.name, gauge.labels, gauge.value);
  }

  for (const histogram of snapshot.histograms) {
    emitHeader(histogram.name, "histogram");
    const buckets = histogram.buckets;
    let cumulative = 0;

    for (let i = 0; i < buckets.boundaries.length; i++) {
      cumulative += buckets.counts[i] ?? 0;
      emitSample(`${histogram.name}_bucket`, { ...histogram.labels, le: String(buckets.boundaries[i]) }, cumulative, buckets.exemplars?.[i]);
    }

    cumulative += buckets.counts[buckets.boundaries.length] ?? 0;
    emitSample(`${histogram.name}_bucket`, { ...histogram.labels, le: "+Inf" }, cumulative, buckets.exemplars?.[buckets.boundaries.length]);
    emitSample(`${histogram.name}_sum`, histogram.labels, buckets.sum);
    emitSample(`${histogram.name}_count`, histogram.labels, buckets.count);
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function metricsSnapshotToOtlp(snapshot: MetricSnapshot, options: OtlpExportOptions = {}) {
  const timeUnixNano = unixNanoFromMs(options.now?.() ?? Date.now());
  const scope: Record<string, unknown> = { name: options.scopeName ?? "brass-runtime" };
  if (options.scopeVersion) scope.version = options.scopeVersion;

  const metrics: Array<Record<string, unknown>> = [];

  for (const counter of snapshot.counters) {
    metrics.push({
      name: counter.name,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [numberDataPoint(counter.labels, counter.value, timeUnixNano)],
      },
    });
  }

  for (const gauge of snapshot.gauges) {
    metrics.push({
      name: gauge.name,
      gauge: {
        dataPoints: [numberDataPoint(gauge.labels, gauge.value, timeUnixNano)],
      },
    });
  }

  for (const histogram of snapshot.histograms) {
    const buckets = histogram.buckets;
    metrics.push({
      name: histogram.name,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [{
          attributes: toOtlpAttributes(histogram.labels),
          timeUnixNano,
          count: String(buckets.count),
          sum: finiteOrZero(buckets.sum),
          min: finiteOrZero(buckets.min),
          max: finiteOrZero(buckets.max),
          explicitBounds: buckets.boundaries,
          bucketCounts: buckets.counts.map((count) => String(count)),
          ...(buckets.exemplars ? { exemplars: buckets.exemplars.filter(isMetricExemplar).map(exemplarToOtlp) } : {}),
        }],
      },
    });
  }

  return {
    resourceMetrics: [{
      resource: { attributes: toOtlpAttributes(options.resource ?? {}) },
      scopeMetrics: [{ scope, metrics }],
    }],
  };
}

export function makeOtlpHttpMetricsExporter(
  registry: MetricsRegistry,
  options: OtlpHttpExporterOptions
) {
  return {
    export: async (): Promise<OtlpHttpExportResult> => {
      const body = JSON.stringify(metricsSnapshotToOtlp(registry.snapshot(), options));
      const response = await postOtlpJson(options, body);
      return { status: response.status, body };
    },
  };
}

export function makeRuntimeMetricsSink(metrics: MetricsRegistry, options: RuntimeMetricsSinkOptions = {}): RuntimeHooks {
  const clock = options.clock ?? Date.now;
  const durationBuckets = [...(options.durationBuckets ?? DEFAULT_DURATION_BUCKETS)];
  const includeEventTotals = options.includeEventTotals ?? true;
  const includeSpanNameLabel = options.includeSpanNameLabel ?? false;
  const fiberStarts = new Map<number, number>();
  const scopeStarts = new Map<number, number>();
  const spanStarts = new Map<string, number>();

  const activeFibers = metrics.gauge("brass_runtime_fibers_active");
  const activeScopes = metrics.gauge("brass_runtime_scopes_active");
  const activeSpans = metrics.gauge("brass_runtime_spans_active");

  return {
    emit(ev, ctx) {
      try {
        if (includeEventTotals) metrics.counter("brass_runtime_events_total", { type: ev.type }).increment();
        recordRuntimeMetricEvent(ev, ctx, clock(), durationBuckets, {
          metrics,
          fiberStarts,
          scopeStarts,
          spanStarts,
          activeFibers,
          activeScopes,
          activeSpans,
          includeSpanNameLabel,
        });
      } catch {
        // Observability sinks should not affect user effects.
      }
    },
  };
}

type RuntimeMetricState = {
  readonly metrics: MetricsRegistry;
  readonly fiberStarts: Map<number, number>;
  readonly scopeStarts: Map<number, number>;
  readonly spanStarts: Map<string, number>;
  readonly activeFibers: ReturnType<MetricsRegistry["gauge"]>;
  readonly activeScopes: ReturnType<MetricsRegistry["gauge"]>;
  readonly activeSpans: ReturnType<MetricsRegistry["gauge"]>;
  readonly includeSpanNameLabel: boolean;
};

function recordRuntimeMetricEvent(
  ev: RuntimeEvent,
  ctx: Parameters<RuntimeHooks["emit"]>[1],
  now: number,
  durationBuckets: readonly number[],
  state: RuntimeMetricState
): void {
  switch (ev.type) {
    case "fiber.start":
      state.fiberStarts.set(ev.fiberId, now);
      state.metrics.counter("brass_runtime_fibers_started_total").increment();
      state.activeFibers.increment();
      return;

    case "fiber.end": {
      state.metrics.counter("brass_runtime_fibers_finished_total", { status: ev.status }).increment();
      decrementIfPositive(state.activeFibers);
      const started = state.fiberStarts.get(ev.fiberId);
      state.fiberStarts.delete(ev.fiberId);
      if (started !== undefined) {
        const durationMs = now - started;
        state.metrics.histogram("brass_runtime_fiber_duration_ms", [...durationBuckets], { status: ev.status }).observe(durationMs, exemplarFromTraceContext(ctx, durationMs, now));
      }
      return;
    }

    case "scope.open":
      state.scopeStarts.set(ev.scopeId, now);
      state.metrics.counter("brass_runtime_scopes_opened_total").increment();
      state.activeScopes.increment();
      return;

    case "scope.close": {
      state.metrics.counter("brass_runtime_scopes_closed_total", { status: ev.status }).increment();
      decrementIfPositive(state.activeScopes);
      const started = state.scopeStarts.get(ev.scopeId);
      state.scopeStarts.delete(ev.scopeId);
      if (started !== undefined) {
        const durationMs = now - started;
        state.metrics.histogram("brass_runtime_scope_duration_ms", [...durationBuckets], { status: ev.status }).observe(durationMs, exemplarFromTraceContext(ctx, durationMs, now));
      }
      return;
    }

    case "span.start":
      if (ctx.spanId) state.spanStarts.set(ctx.spanId, now);
      state.metrics.counter("brass_runtime_spans_started_total", state.includeSpanNameLabel ? { name: ev.name } : {}).increment();
      state.activeSpans.increment();
      return;

    case "span.end": {
      const status = ev.status;
      state.metrics.counter("brass_runtime_spans_finished_total", { status }).increment();
      decrementIfPositive(state.activeSpans);
      if (ctx.spanId) {
        const started = state.spanStarts.get(ctx.spanId);
        state.spanStarts.delete(ctx.spanId);
        if (started !== undefined) {
          const durationMs = now - started;
          state.metrics.histogram("brass_runtime_span_duration_ms", [...durationBuckets], { status }).observe(durationMs, exemplarFromTraceContext(ctx, durationMs, now));
        }
      }
      return;
    }

    case "log":
      state.metrics.counter("brass_runtime_logs_total", { level: ev.level }).increment();
      return;
  }
}

export function exemplarFromTraceContext(
  trace: Pick<Partial<TraceContext>, "traceId" | "spanId"> | undefined,
  value: number,
  timestamp: number = Date.now(),
  labels?: Record<string, string>
): MetricExemplar | undefined {
  if (!trace?.traceId || !trace?.spanId) return undefined;
  return {
    value,
    timestamp,
    traceId: normalizeTraceId(trace.traceId),
    spanId: normalizeSpanId(trace.spanId),
    ...(labels ? { labels } : {}),
  };
}

function decrementIfPositive(gauge: ReturnType<MetricsRegistry["gauge"]>): void {
  if (gauge.value() > 0) gauge.decrement();
}

function numberDataPoint(labels: Record<string, string>, value: number, timeUnixNano: string) {
  return {
    attributes: toOtlpAttributes(labels),
    timeUnixNano,
    asDouble: finiteOrZero(value),
  };
}

function exemplarToOtlp(exemplar: MetricExemplar) {
  return {
    timeUnixNano: unixNanoFromMs(exemplar.timestamp),
    asDouble: finiteOrZero(exemplar.value),
    ...(exemplar.traceId ? { traceId: normalizeTraceId(exemplar.traceId) } : {}),
    ...(exemplar.spanId ? { spanId: normalizeSpanId(exemplar.spanId) } : {}),
    filteredAttributes: toOtlpAttributes(exemplar.labels ?? {}),
  };
}

function isMetricExemplar(value: MetricExemplar | undefined): value is MetricExemplar {
  return value !== undefined;
}

export function toOtlpAttributes(labels: Record<string, OtlpAttributeValue>) {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value: otlpAnyValue(value),
    }));
}

export function otlpAnyValue(value: OtlpAttributeValue) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: finiteOrZero(value) };
  return { stringValue: value };
}

export async function postOtlpJson(options: OtlpHttpExporterOptions, body: string): Promise<OtlpHttpResponse> {
  const fetchImpl = options.fetch ?? (globalThis as any).fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available for OTLP export");
  }

  const response = await fetchImpl(options.url, {
    method: "POST",
    headers: {
      "content-type": OTLP_JSON_CONTENT_TYPE,
      ...(options.headers ?? {}),
    },
    body,
  });

  if (response?.ok === false) {
    let detail = "";
    try {
      detail = response.text ? `: ${await response.text()}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`OTLP export failed with status ${response.status ?? "unknown"}${detail}`);
  }

  return response ?? {};
}

export function unixNanoFromMs(ms: number): string {
  const wholeMs = Math.max(0, Math.trunc(ms));
  return (BigInt(wholeMs) * 1_000_000n).toString();
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${sanitizeLabelName(key)}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function formatExemplar(exemplar: MetricExemplar): string {
  const labels = {
    ...(exemplar.labels ?? {}),
    ...(exemplar.traceId ? { trace_id: normalizeTraceId(exemplar.traceId) } : {}),
    ...(exemplar.spanId ? { span_id: normalizeSpanId(exemplar.spanId) } : {}),
  };
  if (Object.keys(labels).length === 0) return "";
  return ` # ${formatLabels(labels)} ${formatNumber(exemplar.value)} ${formatNumber(exemplar.timestamp / 1000)}`;
}

function sanitizeMetricName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(safe) ? safe : `_${safe}`;
}

function sanitizeLabelName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(safe) ? safe : `_${safe}`;
}

function escapeLabelValue(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function escapeHelp(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
