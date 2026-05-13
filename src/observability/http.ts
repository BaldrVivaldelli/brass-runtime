import { async, asyncFlatMap, asyncFold, asyncFail, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import type { TraceContext } from "../core/runtime/contex";
import type { RuntimeHooks } from "../core/runtime/events";
import { getCurrentFiber } from "../core/runtime/fiber";
import type { Counter, Gauge, Histogram, MetricsRegistry } from "../core/runtime/metrics";
import { Cause, type Exit } from "../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../http/client";
import type { AdaptiveLimiterStats } from "../http/adaptiveLimiter";
import { registerHttpEffect } from "../http/effectRunner";
import { httpErrorStatus, isRetryableHttpError } from "../http/errors";
import { getHttpRequestPolicy, type HttpRequestPolicy, type HttpRequestRetryOverride } from "../http/requestPolicy";
import type { Observability } from "./setup";
import { logEffect, type LogLevel } from "./logs";
import { spanEvent, withSpan, type SpanAttributes } from "./traces";
import { exemplarFromTraceContext } from "./metrics";
import { injectTraceContext } from "./traceContext";
import { shouldSampleWith } from "./sampling";
import { validateHttpObservabilityOptions } from "./configValidation";

export type HttpOutcome =
  | "success"
  | "error"
  | "abort"
  | "bad_url"
  | "fetch_error"
  | "timeout"
  | "pool_rejected"
  | "pool_timeout"
  | "pool_closed"
  | "batch_split_error";

export type HttpObservabilityLogOptions = {
  readonly requestLevel?: LogLevel | false;
  readonly responseLevel?: LogLevel | false;
  readonly errorLevel?: LogLevel | false;
};

export type HttpObservabilitySpanOptions = {
  readonly name?: string | ((req: HttpRequest) => string);
  readonly attributes?: SpanAttributes | ((req: HttpRequest) => SpanAttributes);
  readonly events?: boolean;
  readonly sampleRate?: number;
};

export type HttpAdaptiveLimiterObservabilityOptions = {
  readonly enabled?: boolean;
  /**
   * Adds a `key` metric label when a stable limiter key can be inferred.
   * Keep disabled for high-cardinality downstreams.
   */
  readonly includeKeyLabel?: boolean;
};

export type HttpPolicyLabelKey = "preset" | "lane" | "poolKey" | "dedupKey" | "priority" | "retry";

export type HttpPolicyObservabilityOptions = {
  readonly enabled?: boolean;
  /**
   * Adds selected policy fields as metric labels. Disabled by default because
   * pool keys, lanes, and dedup keys may be high-cardinality in user systems.
   */
  readonly labelKeys?: readonly HttpPolicyLabelKey[];
};

export type HttpObservabilityOptions = {
  readonly metrics?: MetricsRegistry | false;
  readonly logs?: false | HttpObservabilityLogOptions;
  readonly spans?: false | HttpObservabilitySpanOptions;
  readonly spanSink?: RuntimeHooks | false;
  readonly adaptiveLimiter?: boolean | HttpAdaptiveLimiterObservabilityOptions;
  readonly policy?: boolean | HttpPolicyObservabilityOptions;
  readonly injectTraceHeaders?: boolean;
  readonly includeHostLabel?: boolean;
  readonly route?: string | ((req: HttpRequest) => string | undefined);
  readonly clock?: () => number;
  readonly durationBuckets?: readonly number[];
};

type ResolvedHttpObservabilityOptions = Required<Pick<
  HttpObservabilityOptions,
  "injectTraceHeaders" | "includeHostLabel" | "clock"
>> & {
  readonly metrics?: MetricsRegistry;
  readonly logs: false | HttpObservabilityLogOptions;
  readonly spans: false | HttpObservabilitySpanOptions;
  readonly spanSink?: RuntimeHooks;
  readonly adaptiveLimiter: Required<HttpAdaptiveLimiterObservabilityOptions>;
  readonly policy: ResolvedHttpPolicyObservabilityOptions;
  readonly route?: string | ((req: HttpRequest) => string | undefined);
  readonly durationBuckets?: readonly number[];
};

type ResolvedHttpPolicyObservabilityOptions = {
  readonly enabled: boolean;
  readonly labelKeys: readonly HttpPolicyLabelKey[];
};

const DEFAULT_DURATION_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_HTTP_METRIC_CACHE_ENTRIES = 4_096;
const EMPTY_SPAN_ATTRIBUTES: SpanAttributes = Object.freeze({});
const TRACE_SAMPLER_RATIO = Symbol.for("brass-runtime.traceSampler.ratio");
const POLICY_LABEL_NAMES: Record<HttpPolicyLabelKey, string> = {
  preset: "policy",
  lane: "lane",
  poolKey: "pool_key",
  dedupKey: "dedup_key",
  priority: "priority",
  retry: "retry",
};

export const HTTP_OBSERVABILITY_CONTRACT = Object.freeze({
  metrics: Object.freeze({
    requestsTotal: "brass_http_client_requests_total",
    durationMs: "brass_http_client_duration_ms",
    inFlight: "brass_http_client_in_flight",
    adaptiveLimiterLimit: "brass_http_adaptive_limiter_limit",
    adaptiveLimiterInFlight: "brass_http_adaptive_limiter_in_flight",
    adaptiveLimiterQueueDepth: "brass_http_adaptive_limiter_queue_depth",
    adaptiveLimiterStateCount: "brass_http_adaptive_limiter_state_count",
    adaptiveLimiterUtilization: "brass_http_adaptive_limiter_utilization",
    adaptiveLimiterErrorRate: "brass_http_adaptive_limiter_error_rate",
    adaptiveLimiterRequestsPerSecond: "brass_http_adaptive_limiter_requests_per_second",
    adaptiveLimiterCompletionsPerSecond: "brass_http_adaptive_limiter_completions_per_second",
    adaptiveLimiterRejectionRate: "brass_http_adaptive_limiter_rejection_rate",
  }),
  labels: Object.freeze({
    method: "method",
    host: "host",
    route: "route",
    outcome: "outcome",
    status: "status",
    adaptiveLimiterKey: "key",
    lane: "lane",
    poolKey: "pool_key",
    dedupKey: "dedup_key",
    priority: "priority",
    retry: "retry",
    policy: "policy",
  }),
  spanAttributes: Object.freeze({
    method: "http.request.method",
    url: "url.full",
    route: "http.route",
    host: "server.address",
    durationMs: "http.duration_ms",
    outcome: "http.outcome",
    statusCode: "http.status_code",
    retryable: "http.retryable",
    policyLane: "http.request.policy.lane",
    policyPreset: "http.request.policy.preset",
    policyPoolKey: "http.request.policy.pool_key",
    policyDedupKey: "http.request.policy.dedup_key",
    policyPriority: "http.request.policy.priority",
    policyRetry: "http.request.policy.retry",
  }),
  logMessages: Object.freeze({
    request: "http.client.request",
    response: "http.client.response",
    error: "http.client.error",
  }),
  logFields: Object.freeze({
    method: "method",
    url: "url",
    host: "host",
    route: "route",
    status: "status",
    outcome: "outcome",
    durationMs: "durationMs",
    retryable: "retryable",
    policy: "policy",
  }),
} as const);

export function withHttpObservability(options?: Observability | HttpObservabilityOptions): HttpMiddleware {
  if (!isObservabilityInstance(options)) {
    validateHttpObservabilityOptions(options ?? {});
  }
  const resolved = resolveHttpObservabilityOptions(options);
  const metricCache = makeHttpMetricCache();
  attachMetricCache(resolved.metrics, metricCache);

  return (next: HttpClientFn): HttpClientFn => {
    const adaptiveLimiter = adaptiveLimiterOf(next);
    if (canUseLeanHttpMetricsPath(resolved, adaptiveLimiter)) {
      return withLeanHttpMetricsObservability(next, resolved, metricCache);
    }
    if (canUseLeanHttpSampledSpanPath(resolved, adaptiveLimiter)) {
      return withLeanHttpSampledSpanObservability(next, resolved, metricCache);
    }

    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      const run = asyncFlatMap(beginHttpObservation(req, resolved, metricCache), (state) =>
        asyncFlatMap(logHttpRequest(req, resolved), () =>
          asyncFlatMap(prepareHttpRequest(req, resolved), (wireReq) =>
            asyncFold(
              next(wireReq),
              (error: HttpError): Async<unknown, HttpError, HttpWireResponse> => {
                const finish = state.finishWithError(error);
                const adaptiveLimiterAttrs = observeAdaptiveLimiter(wireReq, next, resolved);
                const traceEvent = !shouldEmitHttpSpanEvents(resolved)
                  ? asyncSucceed(undefined)
                  : spanEvent("http.client.error", {
                      ...finish.spanAttributes,
                      ...adaptiveLimiterAttrs,
                      "error.type": error._tag,
                    });
                return asyncFlatMap(
                  traceEvent,
                  () => asyncFlatMap(logHttpError(req, error, finish, resolved), () => asyncFail(error))
                );
              },
              (res: HttpWireResponse): Async<unknown, HttpError, HttpWireResponse> => {
                const finish = state.finishWithResponse(res);
                const adaptiveLimiterAttrs = observeAdaptiveLimiter(wireReq, next, resolved);
                const traceEvent = !shouldEmitHttpSpanEvents(resolved)
                  ? asyncSucceed(undefined)
                  : spanEvent("http.client.response", {
                      ...finish.spanAttributes,
                      ...adaptiveLimiterAttrs,
                    });
                return asyncFlatMap(
                  traceEvent,
                  () => asyncFlatMap(logHttpResponse(req, res, finish, resolved), () => asyncSucceed(res))
                );
              }
            )
          )
        )
      );

      if (resolved.spans === false) return run;
      return withSpan(spanName(req, resolved.spans), run, spanStartAttributes(req, resolved));
    };
  };
}

export const makeHttpObservabilityMiddleware = withHttpObservability;

type HttpObservationFinish = {
  readonly durationMs: number;
  readonly outcome: HttpOutcome;
  readonly labels: Record<string, string>;
  readonly spanAttributes: SpanAttributes;
};

type ActiveHttpObservation = {
  readonly finishWithResponse: (res: HttpWireResponse) => HttpObservationFinish;
  readonly finishWithError: (error: HttpError) => HttpObservationFinish;
};

type LeanHttpSpan = {
  readonly fiber: any;
  readonly sink: RuntimeHooks;
  readonly previousTrace: TraceContext | null;
  readonly trace: TraceContext;
  readonly name: string;
  ended: boolean;
};

type LeanHttpFinishMetrics = {
  readonly counter: Counter;
  readonly histogram: Histogram;
};

type CachedHttpMetricHandles = {
  readonly baseLabels: Record<string, string>;
  readonly inFlight?: Gauge;
  readonly finishMetrics: Map<string, LeanHttpFinishMetrics>;
};

type HttpMetricCache = {
  disabled: boolean;
  readonly leanEntries: Map<string, CachedHttpMetricHandles>;
  readonly inFlightGauges: Map<string, Gauge>;
  readonly requestCounters: Map<string, Counter>;
  readonly durationHistograms: Map<string, Histogram>;
};

type MetricResetRegistryEntry = {
  readonly caches: Set<HttpMetricCache>;
  readonly reset: () => void;
};

const metricResetRegistry = new WeakMap<MetricsRegistry, MetricResetRegistryEntry>();

function canUseLeanHttpMetricsPath(
  options: ResolvedHttpObservabilityOptions,
  adaptiveLimiter: AdaptiveLimiterReadable | undefined,
): boolean {
  return Boolean(
    options.metrics &&
    options.logs === false &&
    options.spans === false &&
    !options.injectTraceHeaders &&
    (!options.adaptiveLimiter.enabled || !adaptiveLimiter)
  );
}

function canUseLeanHttpSampledSpanPath(
  options: ResolvedHttpObservabilityOptions,
  adaptiveLimiter: AdaptiveLimiterReadable | undefined,
): boolean {
  return Boolean(
    options.spans !== false &&
    options.spans.events === false &&
    options.logs === false &&
    !options.injectTraceHeaders &&
    (!options.adaptiveLimiter.enabled || !adaptiveLimiter)
  );
}

function withLeanHttpSampledSpanObservability(
  next: HttpClientFn,
  options: ResolvedHttpObservabilityOptions,
  metricCache: HttpMetricCache,
): HttpClientFn {
  return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> =>
    async((env, cb) => {
      const startedAt = options.clock();
      const baseLabels = requestBaseLabels(req, options);
      const handles = beginLeanHttpMetricsObservation(baseLabels, options, metricCache);
      const span = startLeanHttpSpan(req, options);
      let finished = false;
      let cancelInner: (() => void) | undefined;

      const finish = (exit: Exit<HttpError, HttpWireResponse>): void => {
        if (finished) return;
        finished = true;
        cancelInner = undefined;

        if (exit._tag === "Success") {
          recordHttpMetricsFinish(
            handles,
            httpStatusOutcome(exit.value.status),
            String(exit.value.status),
            startedAt,
            options,
            metricCache,
          );
          finishLeanHttpSpan(span, "success");
        } else {
          const error = httpErrorFromCause(exit.cause);
          const status = httpErrorStatus(error);
          recordHttpMetricsFinish(
            handles,
            httpErrorOutcome(error),
            status !== undefined ? String(status) : undefined,
            startedAt,
            options,
            metricCache,
          );
          finishLeanHttpSpan(span, Cause.containsInterrupt(exit.cause) ? "interrupted" : "failure", error);
        }

        cb(exit);
      };

      try {
        cancelInner = registerHttpEffect(next(req), env, finish);
      } catch (error) {
        const defectExit: Exit<HttpError, HttpWireResponse> = {
          _tag: "Failure",
          cause: Cause.die(error),
        };
        finish(defectExit);
      }

      return () => {
        if (!finished) {
          finished = true;
          recordHttpMetricsFinish(
            handles,
            "abort",
            undefined,
            startedAt,
            options,
            metricCache,
          );
          finishLeanHttpSpan(span, "interrupted");
        }
        const cancel = cancelInner;
        cancelInner = undefined;
        cancel?.();
      };
    }) as Async<unknown, HttpError, HttpWireResponse>;
}

function withLeanHttpMetricsObservability(
  next: HttpClientFn,
  options: ResolvedHttpObservabilityOptions,
  metricCache: HttpMetricCache,
): HttpClientFn {
  return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> =>
    async((env, cb) => {
      const startedAt = options.clock();
      const baseLabels = requestBaseLabels(req, options);
      const handles = beginLeanHttpMetricsObservation(baseLabels, options, metricCache);
      let finished = false;
      let cancelInner: (() => void) | undefined;

      const finish = (exit: Exit<HttpError, HttpWireResponse>): void => {
        if (finished) return;
        finished = true;
        cancelInner = undefined;

        if (exit._tag === "Success") {
          recordHttpMetricsFinish(
            handles,
            httpStatusOutcome(exit.value.status),
            String(exit.value.status),
            startedAt,
            options,
            metricCache,
          );
        } else {
          const error = httpErrorFromCause(exit.cause);
          const status = httpErrorStatus(error);
          recordHttpMetricsFinish(
            handles,
            httpErrorOutcome(error),
            status !== undefined ? String(status) : undefined,
            startedAt,
            options,
            metricCache,
          );
        }

        cb(exit);
      };

      try {
        cancelInner = registerHttpEffect(next(req), env, finish);
      } catch (error) {
        const defectExit: Exit<HttpError, HttpWireResponse> = {
          _tag: "Failure",
          cause: Cause.die(error),
        };
        finish(defectExit);
      }

      return () => {
        if (!finished) {
          finished = true;
          recordHttpMetricsFinish(
            handles,
            "abort",
            undefined,
            startedAt,
            options,
            metricCache,
          );
        }
        const cancel = cancelInner;
        cancelInner = undefined;
        cancel?.();
      };
    }) as Async<unknown, HttpError, HttpWireResponse>;
}

function beginLeanHttpMetricsObservation(
  baseLabels: Record<string, string>,
  options: ResolvedHttpObservabilityOptions,
  metricCache: HttpMetricCache,
): CachedHttpMetricHandles {
  const cacheKey = metricCacheKey("brass_http_client", baseLabels);
  const existing = metricCache.disabled ? undefined : metricCache.leanEntries.get(cacheKey);
  if (existing) {
    existing.inFlight?.increment();
    return existing;
  }

  const inFlight = options.metrics
    ? getCachedMetric(
        metricCache,
        metricCache.inFlightGauges,
        metricCacheKey("brass_http_client_in_flight", baseLabels),
        () => options.metrics!.gauge("brass_http_client_in_flight", baseLabels),
      )
    : undefined;

  inFlight?.increment();
  const created = {
    baseLabels,
    inFlight,
    finishMetrics: new Map<string, LeanHttpFinishMetrics>(),
  };
  if (!metricCache.disabled && metricCache.leanEntries.size < MAX_HTTP_METRIC_CACHE_ENTRIES) {
    metricCache.leanEntries.set(cacheKey, created);
  }
  return created;
}

function recordHttpMetricsFinish(
  handles: CachedHttpMetricHandles,
  outcome: HttpOutcome,
  status: string | undefined,
  startedAt: number,
  options: ResolvedHttpObservabilityOptions,
  metricCache: HttpMetricCache,
): void {
  const durationMs = Math.max(0, options.clock() - startedAt);

  handles.inFlight?.decrement();
  if (!options.metrics) return;

  const finishKey = `${outcome}|${status ?? "none"}`;
  let finishMetrics = metricCache.disabled ? undefined : handles.finishMetrics.get(finishKey);
  if (!finishMetrics) {
    const labels = requestFinishLabelsFromBase(handles.baseLabels, outcome, status);
    finishMetrics = {
      counter: options.metrics.counter("brass_http_client_requests_total", labels),
      histogram: options.metrics.histogram(
        "brass_http_client_duration_ms",
        [...(options.durationBuckets ?? DEFAULT_DURATION_BUCKETS)],
        labels,
      ),
    };
    if (!metricCache.disabled) handles.finishMetrics.set(finishKey, finishMetrics);
  }

  finishMetrics.counter.increment();
  finishMetrics.histogram.observe(durationMs);
}

function startLeanHttpSpan(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions,
): LeanHttpSpan | undefined {
  const configuredSampleRate = options.spans === false ? undefined : options.spans.sampleRate;
  if (configuredSampleRate !== undefined) {
    if (configuredSampleRate <= 0) return undefined;
    if (configuredSampleRate < 1 && Math.random() >= configuredSampleRate) return undefined;
  }

  const fiber = getCurrentFiber() as any;
  const runtime = fiber?.runtime;
  const sink = options.spanSink ?? runtime?.hooks;
  if (!fiber?.fiberContext || !runtime || !sink) return undefined;

  const previousTrace = fiber.fiberContext.trace ?? null;
  const brass = runtime.env?.brass;
  if (previousTrace?.sampled === false && brass?.respectRemoteSampled !== false) return undefined;

  const name = spanName(req, options.spans);
  const tracer = resolveRuntimeTracer(runtime);
  let traceId = previousTrace?.traceId;
  let sampled = previousTrace?.sampled;
  let attributes: SpanAttributes | undefined;

  if (!previousTrace && configuredSampleRate === undefined) {
    const ratio = traceSamplerRatio(brass?.sampler);
    if (ratio !== undefined) {
      if (ratio <= 0) return undefined;
      if (ratio < 1 && Math.random() >= ratio) return undefined;
      sampled = true;
    }
    traceId = tracer.newTraceId();
  } else if (!previousTrace) {
    sampled = true;
    traceId = tracer.newTraceId();
  }

  attributes = spanStartAttributes(req, options);
  if (sampled === undefined) {
    traceId = traceId ?? tracer.newTraceId();
    sampled = shouldSampleWith(brass?.sampler, {
      traceId,
      spanName: name,
      parentSampled: previousTrace?.sampled,
      attributes,
    });
  }
  if (sampled === false) return undefined;

  const trace: TraceContext = {
    traceId: traceId ?? tracer.newTraceId(),
    spanId: tracer.newSpanId(),
    parentSpanId: previousTrace?.spanId,
    sampled: true,
    traceState: previousTrace?.traceState,
    ...(previousTrace?.baggage ? { baggage: previousTrace.baggage } : {}),
  };
  const state: LeanHttpSpan = {
    fiber,
    sink,
    previousTrace,
    trace,
    name,
    ended: false,
  };

  fiber.fiberContext = { ...fiber.fiberContext, trace };
  fiber.addFinalizer?.((exit: Exit<unknown, unknown>) => {
    const status = exit?._tag === "Success"
      ? "success"
      : exit?.cause && Cause.containsInterrupt(exit.cause as any)
        ? "interrupted"
        : "failure";
    finishLeanHttpSpan(state, status, exit?._tag === "Failure" ? exit.cause : undefined);
  });
  sink.emit(
    { type: "span.start", name, attributes, links: [] },
    leanSpanContext(fiber, trace),
  );
  return state;
}

function finishLeanHttpSpan(
  state: LeanHttpSpan | undefined,
  status: "success" | "failure" | "interrupted",
  error?: unknown,
): void {
  if (!state || state.ended) return;
  state.ended = true;
  state.sink.emit(
    { type: "span.end", name: state.name, status, error },
    leanSpanContext(state.fiber, state.trace),
  );
  if (state.fiber?.fiberContext) {
    state.fiber.fiberContext = { ...state.fiber.fiberContext, trace: state.previousTrace };
  }
}

function leanSpanContext(fiber: any, trace: TraceContext) {
  return {
    fiberId: fiber?.id,
    scopeId: fiber?.scopeId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
    traceState: trace.traceState,
    baggage: trace.baggage,
    sampled: trace.sampled,
  };
}

function resolveRuntimeTracer(runtime: any) {
  const tracer = runtime?.env?.brass?.tracer;
  if (tracer?.newTraceId && tracer?.newSpanId) return tracer;
  return {
    newTraceId: () => randomRuntimeId("trace"),
    newSpanId: () => randomRuntimeId("span"),
  };
}

function traceSamplerRatio(sampler: unknown): number | undefined {
  if (!sampler || typeof sampler === "function") return undefined;
  const ratio = (sampler as any)[TRACE_SAMPLER_RATIO];
  return typeof ratio === "number" && Number.isFinite(ratio) ? ratio : undefined;
}

function randomRuntimeId(prefix: string): string {
  const cryptoLike = (globalThis as any).crypto;
  if (typeof cryptoLike?.randomUUID === "function") return cryptoLike.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function httpErrorFromCause(cause: Cause<HttpError>): HttpError {
  const failure = Cause.firstFailure(cause);
  if (failure._tag === "Some") return failure.value;
  if (Cause.containsInterrupt(cause)) return { _tag: "Abort" };

  const defect = Cause.firstDefect(cause);
  const value = defect._tag === "Some" ? defect.value : Cause.toError(cause);
  return {
    _tag: "FetchError",
    message: value instanceof Error ? value.message : String(value),
    cause: value,
  };
}

function makeHttpMetricCache(): HttpMetricCache {
  return {
    disabled: false,
    leanEntries: new Map(),
    inFlightGauges: new Map(),
    requestCounters: new Map(),
    durationHistograms: new Map(),
  };
}

function attachMetricCache(metrics: MetricsRegistry | undefined, cache: HttpMetricCache): void {
  if (!metrics) return;
  const existing = metricResetRegistry.get(metrics);
  if (existing) {
    existing.caches.add(cache);
    return;
  }

  const entry: MetricResetRegistryEntry = {
    caches: new Set([cache]),
    reset: metrics.reset.bind(metrics),
  };

  try {
    Object.defineProperty(metrics, "reset", {
      configurable: true,
      value: () => {
        for (const cached of entry.caches) clearHttpMetricCache(cached);
        entry.reset();
      },
    });
    metricResetRegistry.set(metrics, entry);
  } catch {
    cache.disabled = true;
  }
}

function clearHttpMetricCache(cache: HttpMetricCache): void {
  cache.leanEntries.clear();
  cache.inFlightGauges.clear();
  cache.requestCounters.clear();
  cache.durationHistograms.clear();
}

function getCachedMetric<A>(
  owner: HttpMetricCache,
  cache: Map<string, A>,
  key: string,
  create: () => A,
): A {
  if (owner.disabled) return create();
  const existing = cache.get(key);
  if (existing) return existing;
  const created = create();
  if (cache.size < MAX_HTTP_METRIC_CACHE_ENTRIES) {
    cache.set(key, created);
  }
  return created;
}

function metricCacheKey(name: string, labels: Record<string, string>): string {
  let key = name;
  for (const [label, value] of Object.entries(labels)) {
    key += `|${label.length}:${label}=${value.length}:${value}`;
  }
  return key;
}

function beginHttpObservation(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions,
  metricCache: HttpMetricCache,
): Async<unknown, never, ActiveHttpObservation> {
  return asyncSync(() => {
    const startedAt = options.clock();
    let finished = false;
    const baseLabels = requestBaseLabels(req, options);
    const inFlight = options.metrics
      ? getCachedMetric(
          metricCache,
          metricCache.inFlightGauges,
          metricCacheKey("brass_http_client_in_flight", baseLabels),
          () => options.metrics!.gauge("brass_http_client_in_flight", baseLabels),
        )
      : undefined;
    inFlight?.increment();

    const finish = (outcome: HttpOutcome, status: string | undefined, extra: SpanAttributes = {}): HttpObservationFinish => {
      const durationMs = Math.max(0, options.clock() - startedAt);
      const labels = requestFinishLabelsFromBase(baseLabels, outcome, status);

      if (!finished) {
        finished = true;
        if (inFlight && inFlight.value() > 0) inFlight.decrement();
        if (options.metrics) {
          getCachedMetric(
            metricCache,
            metricCache.requestCounters,
            metricCacheKey("brass_http_client_requests_total", labels),
            () => options.metrics!.counter("brass_http_client_requests_total", labels),
          ).increment();
          getCachedMetric(
            metricCache,
            metricCache.durationHistograms,
            metricCacheKey("brass_http_client_duration_ms", labels),
            () => options.metrics!.histogram(
              "brass_http_client_duration_ms",
              [...(options.durationBuckets ?? DEFAULT_DURATION_BUCKETS)],
              labels,
            ),
          ).observe(
            durationMs,
            options.spans === false ? undefined : currentTraceExemplar(durationMs, startedAt + durationMs),
          );
        }
      }

      return {
        durationMs,
        outcome,
        labels,
        spanAttributes: options.spans === false
          ? EMPTY_SPAN_ATTRIBUTES
          : {
              "http.duration_ms": durationMs,
              "http.outcome": outcome,
              ...(status ? { "http.status_code": Number(status) } : {}),
              ...(status ? { "http.response.status_code": Number(status) } : {}),
              ...extra,
            },
      };
    };

    const fiber = getCurrentFiber() as any;
    fiber?.addFinalizer?.(() => {
      finish("abort", undefined, { "http.cancelled": true });
    });

    return {
      finishWithResponse: (res) => finish(httpStatusOutcome(res.status), String(res.status)),
      finishWithError: (error) => {
        const status = httpErrorStatus(error);
        return finish(httpErrorOutcome(error), status !== undefined ? String(status) : undefined, {
          "error.type": error._tag,
          "http.retryable": isRetryableHttpError(error),
        });
      },
    };
  }) as Async<unknown, never, ActiveHttpObservation>;
}

function prepareHttpRequest(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions
): Async<unknown, never, HttpRequest> {
  if (!options.injectTraceHeaders) return asyncSucceed(req);
  return asyncSync(() => injectCurrentTraceContext(req)) as Async<unknown, never, HttpRequest>;
}

function logHttpRequest(req: HttpRequest, options: ResolvedHttpObservabilityOptions): Async<unknown, never, void> {
  const level = options.logs === false ? false : options.logs.requestLevel ?? false;
  if (!level) return asyncSucceed(undefined);
  return logEffect(level, "http.client.request", requestLogFields(req, options));
}

function logHttpResponse(
  req: HttpRequest,
  res: HttpWireResponse,
  finish: HttpObservationFinish,
  options: ResolvedHttpObservabilityOptions
): Async<unknown, never, void> {
  const configured = options.logs === false ? false : options.logs.responseLevel ?? false;
  const level = configured || (finish.outcome === "error" ? (options.logs !== false ? options.logs.errorLevel ?? "warn" : false) : false);
  if (!level) return asyncSucceed(undefined);
  return logEffect(level, "http.client.response", {
    ...requestLogFields(req, options),
    status: res.status,
    statusText: res.statusText,
    outcome: finish.outcome,
    durationMs: finish.durationMs,
  });
}

function logHttpError(
  req: HttpRequest,
  error: HttpError,
  finish: HttpObservationFinish,
  options: ResolvedHttpObservabilityOptions
): Async<unknown, never, void> {
  const level = options.logs === false ? false : options.logs.errorLevel ?? "error";
  if (!level) return asyncSucceed(undefined);
  const status = httpErrorStatus(error);
  const statusText = httpErrorStatusText(error);
  return logEffect(level, "http.client.error", {
    ...requestLogFields(req, options),
    outcome: finish.outcome,
    durationMs: finish.durationMs,
    ...(status !== undefined ? { status } : {}),
    ...(statusText ? { statusText } : {}),
    retryable: isRetryableHttpError(error),
    errorTag: error._tag,
    message: httpErrorMessage(error),
  });
}

function resolveHttpObservabilityOptions(options?: Observability | HttpObservabilityOptions): ResolvedHttpObservabilityOptions {
  const maybeObservability = isObservabilityInstance(options)
    ? options as Observability
    : undefined;
  const raw = maybeObservability ? { metrics: maybeObservability.metrics } satisfies HttpObservabilityOptions : options as HttpObservabilityOptions | undefined;

  return {
    metrics: raw?.metrics === false ? undefined : raw?.metrics,
    logs: raw?.logs ?? {},
    spans: raw?.spans ?? {},
    spanSink: raw?.spanSink === false ? undefined : raw?.spanSink,
    adaptiveLimiter: resolveAdaptiveLimiterObservabilityOptions(raw?.adaptiveLimiter),
    policy: resolveHttpPolicyObservabilityOptions(raw?.policy),
    injectTraceHeaders: raw?.injectTraceHeaders ?? true,
    includeHostLabel: raw?.includeHostLabel ?? true,
    route: raw?.route,
    clock: raw?.clock ?? Date.now,
    durationBuckets: raw?.durationBuckets,
  };
}

function isObservabilityInstance(options: unknown): options is Observability {
  return Boolean(
    options &&
    typeof options === "object" &&
    "eventBus" in options &&
    "prometheus" in options
  );
}

type AdaptiveLimiterReadable = {
  readonly stats: () => AdaptiveLimiterStats;
};

function resolveAdaptiveLimiterObservabilityOptions(
  options: HttpObservabilityOptions["adaptiveLimiter"],
): Required<HttpAdaptiveLimiterObservabilityOptions> {
  if (options === false) return { enabled: false, includeKeyLabel: false };
  if (options === true || options === undefined) return { enabled: true, includeKeyLabel: false };
  return {
    enabled: options.enabled ?? true,
    includeKeyLabel: options.includeKeyLabel ?? false,
  };
}

function resolveHttpPolicyObservabilityOptions(
  options: HttpObservabilityOptions["policy"],
): ResolvedHttpPolicyObservabilityOptions {
  if (options === false) return { enabled: false, labelKeys: [] };
  if (options === true || options === undefined) return { enabled: true, labelKeys: [] };
  return {
    enabled: options.enabled ?? true,
    labelKeys: options.labelKeys ?? [],
  };
}

function observeAdaptiveLimiter(
  req: HttpRequest,
  next: HttpClientFn,
  options: ResolvedHttpObservabilityOptions,
): SpanAttributes {
  if (!options.adaptiveLimiter.enabled) return {};
  const limiter = adaptiveLimiterOf(next);
  if (!limiter || (!options.metrics && options.spans === false)) return {};

  const stats = limiter.stats();
  const labels = adaptiveLimiterLabels(req, stats, options);

  setGauge(options.metrics, "brass_http_adaptive_limiter_limit", stats.limit, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_in_flight", stats.inFlight, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_queue_depth", stats.queueDepth, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_state_count", stats.stateCount, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_utilization", stats.utilization, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_error_rate", stats.errorRate, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_requests_per_second", stats.requestsPerSecond, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_completions_per_second", stats.completionsPerSecond, labels);
  setGauge(options.metrics, "brass_http_adaptive_limiter_rejection_rate", stats.rejectionRate, labels);

  return compactSpanAttributes({
    "http.adaptive_limiter.limit": stats.limit,
    "http.adaptive_limiter.in_flight": stats.inFlight,
    "http.adaptive_limiter.queue_depth": stats.queueDepth,
    "http.adaptive_limiter.state_count": stats.stateCount,
    "http.adaptive_limiter.utilization": stats.utilization,
    "http.adaptive_limiter.error_rate": stats.errorRate,
    "http.adaptive_limiter.requests_per_second": stats.requestsPerSecond,
    "http.adaptive_limiter.completions_per_second": stats.completionsPerSecond,
    "http.adaptive_limiter.rejection_rate": stats.rejectionRate,
  });
}

function adaptiveLimiterOf(next: HttpClientFn): AdaptiveLimiterReadable | undefined {
  const limiter = (next as { readonly adaptiveLimiter?: AdaptiveLimiterReadable }).adaptiveLimiter;
  return limiter && typeof limiter.stats === "function" ? limiter : undefined;
}

function adaptiveLimiterLabels(
  req: HttpRequest,
  stats: AdaptiveLimiterStats,
  options: ResolvedHttpObservabilityOptions,
): Record<string, string> {
  const key = options.adaptiveLimiter.includeKeyLabel
    ? inferAdaptiveLimiterKey(req, stats)
    : undefined;
  return compactLabels({
    ...requestBaseLabels(req, options),
    key,
  });
}

function inferAdaptiveLimiterKey(req: HttpRequest, stats: AdaptiveLimiterStats): string | undefined {
  const policy = getHttpRequestPolicy(req);
  if (policy.poolKey) return policy.poolKey;
  const host = requestHost(req);
  if (host) return host;
  return stats.keys?.length === 1 ? stats.keys[0] : undefined;
}

function setGauge(
  metrics: MetricsRegistry | undefined,
  name: string,
  value: number | undefined,
  labels: Record<string, string>,
): void {
  if (!metrics || value === undefined || !Number.isFinite(value)) return;
  metrics.gauge(name, labels).set(value);
}

function compactSpanAttributes(attrs: Record<string, string | number | boolean | undefined>): SpanAttributes {
  const out: SpanAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function spanName(req: HttpRequest, options: false | HttpObservabilitySpanOptions): string {
  if (options && options.name) {
    return typeof options.name === "function" ? options.name(req) : options.name;
  }
  return `HTTP ${req.method}`;
}

function shouldEmitHttpSpanEvents(options: ResolvedHttpObservabilityOptions): boolean {
  return options.spans !== false && options.spans.events !== false;
}

function spanStartAttributes(req: HttpRequest, options: ResolvedHttpObservabilityOptions): SpanAttributes {
  const spanOptions = options.spans === false ? {} : options.spans.attributes;
  const custom = typeof spanOptions === "function" ? spanOptions(req) : spanOptions ?? {};
  const host = requestHost(req);
  const route = requestRoute(req, options);
  const sanitizedUrl = sanitizeUrl(req.url);
  const scheme = urlScheme(req.url);
  const path = urlPath(req.url);

  return {
    "span.kind": "client",
    "http.method": req.method,
    "http.request.method": req.method,
    "http.url": sanitizedUrl,
    "url.full": sanitizedUrl,
    ...(scheme ? { "url.scheme": scheme } : {}),
    ...(path ? { "url.path": path } : {}),
    ...(host ? { "server.address": host } : {}),
    ...(route ? { "http.route": route } : {}),
    ...requestPolicySpanAttributes(req, options),
    ...custom,
  };
}

function requestBaseLabels(req: HttpRequest, options: ResolvedHttpObservabilityOptions): Record<string, string> {
  const route = requestRoute(req, options);
  return compactLabels({
    method: req.method,
    ...(options.includeHostLabel ? { host: requestHost(req) } : {}),
    ...(route ? { route } : {}),
    ...requestPolicyMetricLabels(req, options),
  });
}

function requestFinishLabelsFromBase(
  baseLabels: Record<string, string>,
  outcome: HttpOutcome,
  status: string | undefined,
): Record<string, string> {
  return {
    ...baseLabels,
    outcome,
    status: status ?? "none",
  };
}

function requestLogFields(req: HttpRequest, options: ResolvedHttpObservabilityOptions): Record<string, unknown> {
  const host = requestHost(req);
  const route = requestRoute(req, options);
  const policy = requestPolicyLogFields(req, options);

  return {
    method: req.method,
    url: sanitizeUrl(req.url),
    ...(host ? { host } : {}),
    ...(route ? { route } : {}),
    ...(policy ? { policy } : {}),
  };
}

function requestPolicyLogFields(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions,
): Record<string, unknown> | undefined {
  if (!options.policy.enabled) return undefined;
  const policy = getHttpRequestPolicy(req);
  const fields = {
    ...(policy.preset ? { preset: policy.preset } : {}),
    ...(policy.lane ? { lane: policy.lane } : {}),
    ...(policy.poolKey ? { poolKey: policy.poolKey } : {}),
    ...(policy.dedupKey ? { dedupKey: policy.dedupKey } : {}),
    ...(policy.priority !== undefined ? { priority: policy.priority } : {}),
    ...(policy.retry !== undefined ? { retry: retryPolicyLogValue(policy.retry) } : {}),
  };
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function requestPolicySpanAttributes(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions,
): SpanAttributes {
  if (!options.policy.enabled) return {};
  const policy = getHttpRequestPolicy(req);
  return {
    ...compactSpanAttributes({
      "http.request.policy.lane": policy.lane,
      "http.request.policy.preset": policy.preset,
      "http.request.policy.pool_key": policy.poolKey,
      "http.request.policy.dedup_key": policy.dedupKey,
      "http.request.policy.priority": policy.priority,
    }),
    ...retryPolicySpanAttributes(policy.retry),
  };
}

function requestPolicyMetricLabels(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions,
): Record<string, string> {
  if (!options.policy.enabled || options.policy.labelKeys.length === 0) return {};
  const policy = getHttpRequestPolicy(req);
  const values: Record<HttpPolicyLabelKey, string | undefined> = {
    preset: policy.preset,
    lane: policy.lane,
    poolKey: policy.poolKey,
    dedupKey: policy.dedupKey,
    priority: policy.priority !== undefined ? String(policy.priority) : undefined,
    retry: retryPolicyMetricValue(policy.retry),
  };
  const labels: Record<string, string | undefined> = {};

  for (const key of options.policy.labelKeys) {
    labels[POLICY_LABEL_NAMES[key]] = values[key];
  }

  return compactLabels(labels);
}

function retryPolicyLogValue(retry: HttpRequestRetryOverride): unknown {
  if (retry === false) return "disabled";
  return {
    mode: "override",
    ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
    ...(retry.baseDelayMs !== undefined ? { baseDelayMs: retry.baseDelayMs } : {}),
    ...(retry.maxDelayMs !== undefined ? { maxDelayMs: retry.maxDelayMs } : {}),
    ...(retry.schedule ? { schedule: "custom" } : {}),
    ...(retry.retryOnStatus ? { retryOnStatus: "custom" } : {}),
  };
}

function retryPolicySpanAttributes(retry: HttpRequestPolicy["retry"]): SpanAttributes {
  if (retry === undefined) return {};
  if (retry === false) return { "http.request.policy.retry": "disabled" };
  return compactSpanAttributes({
    "http.request.policy.retry": "override",
    "http.request.policy.retry.max_retries": retry.maxRetries,
    "http.request.policy.retry.base_delay_ms": retry.baseDelayMs,
    "http.request.policy.retry.max_delay_ms": retry.maxDelayMs,
    "http.request.policy.retry.custom_schedule": retry.schedule ? true : undefined,
    "http.request.policy.retry.custom_status": retry.retryOnStatus ? true : undefined,
  });
}

function retryPolicyMetricValue(retry: HttpRequestPolicy["retry"]): string | undefined {
  if (retry === undefined) return undefined;
  return retry === false ? "disabled" : "override";
}

function requestRoute(req: HttpRequest, options: ResolvedHttpObservabilityOptions): string | undefined {
  if (typeof options.route === "function") return options.route(req);
  return options.route;
}

function httpStatusOutcome(status: number): HttpOutcome {
  return status >= 400 ? "error" : "success";
}

function httpErrorOutcome(error: HttpError): HttpOutcome {
  switch (error._tag) {
    case "Abort":
      return "abort";
    case "BadUrl":
      return "bad_url";
    case "FetchError":
      return "fetch_error";
    case "Timeout":
      return "timeout";
    case "PoolRejected":
      return "pool_rejected";
    case "PoolTimeout":
      return "pool_timeout";
    case "PoolClosed":
      return "pool_closed";
    case "BatchSplitError":
      return "batch_split_error";
  }
}

function httpErrorMessage(error: HttpError): string | undefined {
  return "message" in error ? error.message : undefined;
}

function httpErrorStatusText(error: HttpError): string | undefined {
  return error._tag === "FetchError" ? error.statusText : undefined;
}

function injectCurrentTraceContext(req: HttpRequest): HttpRequest {
  const fiber = getCurrentFiber() as any;
  const trace = fiber?.fiberContext?.trace;
  if (!trace?.traceId || !trace?.spanId) return req;

  return {
    ...req,
    headers: injectTraceContext(req.headers, trace),
  };
}

function currentTraceExemplar(value: number, timestamp: number) {
  const fiber = getCurrentFiber() as any;
  return exemplarFromTraceContext(fiber?.fiberContext?.trace, value, timestamp);
}

function requestHost(req: HttpRequest): string | undefined {
  if (!isAbsoluteUrl(req.url)) return undefined;
  try {
    return new URL(req.url).host;
  } catch {
    return undefined;
  }
}

function urlScheme(url: string): string | undefined {
  if (url.startsWith("https://")) return "https";
  if (url.startsWith("http://")) return "http";
  if (!isAbsoluteUrl(url)) return undefined;
  try {
    return new URL(url).protocol.replace(/:$/, "");
  } catch {
    return undefined;
  }
}

function urlPath(url: string): string | undefined {
  if (!isAbsoluteUrl(url)) {
    const path = stripQueryAndHash(url);
    return path.startsWith("/") ? path : undefined;
  }
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function sanitizeUrl(url: string): string {
  if (!isAbsoluteUrl(url)) return stripQueryAndHash(url);
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const [withoutHash] = url.split("#", 1);
    const [withoutQuery] = withoutHash.split("?", 1);
    return withoutQuery;
  }
}

function isAbsoluteUrl(url: string): boolean {
  const schemeIdx = url.indexOf("://");
  if (schemeIdx <= 0) return false;
  const firstSlash = url.indexOf("/");
  return firstSlash === -1 || schemeIdx < firstSlash;
}

function stripQueryAndHash(url: string): string {
  const hashIdx = url.indexOf("#");
  const queryIdx = url.indexOf("?");
  let end = url.length;
  if (hashIdx >= 0) end = Math.min(end, hashIdx);
  if (queryIdx >= 0) end = Math.min(end, queryIdx);
  return url.slice(0, end);
}

function compactLabels(labels: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}
