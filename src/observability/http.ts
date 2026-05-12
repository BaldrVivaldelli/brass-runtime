import { asyncFlatMap, asyncFold, asyncFail, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import { getCurrentFiber } from "../core/runtime/fiber";
import type { MetricsRegistry } from "../core/runtime/metrics";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../http/client";
import type { AdaptiveLimiterStats } from "../http/adaptiveLimiter";
import { httpErrorStatus, isRetryableHttpError } from "../http/errors";
import { getHttpRequestPolicy, type HttpRequestPolicy, type HttpRequestRetryOverride } from "../http/requestPolicy";
import type { Observability } from "./setup";
import { logEffect, type LogLevel } from "./logs";
import { spanEvent, withSpan, type SpanAttributes } from "./traces";
import { exemplarFromTraceContext } from "./metrics";
import { injectTraceContext } from "./traceContext";
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

  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      const run = asyncFlatMap(beginHttpObservation(req, resolved), (state) =>
        asyncFlatMap(logHttpRequest(req, resolved), () =>
          asyncFlatMap(prepareHttpRequest(req, resolved), (wireReq) =>
            asyncFold(
              next(wireReq),
              (error: HttpError): Async<unknown, HttpError, HttpWireResponse> => {
                const finish = state.finishWithError(error);
                const adaptiveLimiterAttrs = observeAdaptiveLimiter(wireReq, next, resolved);
                return asyncFlatMap(
                  spanEvent("http.client.error", {
                    ...finish.spanAttributes,
                    ...adaptiveLimiterAttrs,
                    "error.type": error._tag,
                  }),
                  () => asyncFlatMap(logHttpError(req, error, finish, resolved), () => asyncFail(error))
                );
              },
              (res: HttpWireResponse): Async<unknown, HttpError, HttpWireResponse> => {
                const finish = state.finishWithResponse(res);
                const adaptiveLimiterAttrs = observeAdaptiveLimiter(wireReq, next, resolved);
                return asyncFlatMap(
                  spanEvent("http.client.response", {
                    ...finish.spanAttributes,
                    ...adaptiveLimiterAttrs,
                  }),
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

function beginHttpObservation(
  req: HttpRequest,
  options: ResolvedHttpObservabilityOptions
): Async<unknown, never, ActiveHttpObservation> {
  return asyncSync(() => {
    const startedAt = options.clock();
    let finished = false;
    const inFlight = options.metrics?.gauge("brass_http_client_in_flight", requestBaseLabels(req, options));
    inFlight?.increment();

    const finish = (outcome: HttpOutcome, status: string | undefined, extra: SpanAttributes = {}): HttpObservationFinish => {
      const durationMs = Math.max(0, options.clock() - startedAt);
      const labels = requestFinishLabels(req, outcome, status, options);

      if (!finished) {
        finished = true;
        if (inFlight && inFlight.value() > 0) inFlight.decrement();
        options.metrics?.counter("brass_http_client_requests_total", labels).increment();
        options.metrics?.histogram("brass_http_client_duration_ms", [...(options.durationBuckets ?? DEFAULT_DURATION_BUCKETS)], labels).observe(durationMs, currentTraceExemplar(durationMs, startedAt + durationMs));
      }

      return {
        durationMs,
        outcome,
        labels,
        spanAttributes: {
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

function requestFinishLabels(
  req: HttpRequest,
  outcome: HttpOutcome,
  status: string | undefined,
  options: ResolvedHttpObservabilityOptions
): Record<string, string> {
  return {
    ...requestBaseLabels(req, options),
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
