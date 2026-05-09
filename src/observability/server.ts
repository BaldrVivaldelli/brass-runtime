import type { MetricsRegistry } from "../core/runtime/metrics";
import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed, type Async } from "../core/types/asyncEffect";
import { logEffect, type LogLevel } from "./logs";
import { exemplarFromTraceContext } from "./metrics";
import type { Observability } from "./setup";
import {
  makeRequestObservabilityContext,
  type RequestObservabilityContext,
  type RequestObservabilityContextInput,
  type RequestObservabilityRuntimeOptions,
} from "./request";
import { spanEvent, type SpanAttributes } from "./traces";

export type HttpServerOutcome = "success" | "error" | "exception";

export type HttpServerObservabilityLogOptions = {
  readonly requestLevel?: LogLevel | false;
  readonly responseLevel?: LogLevel | false;
  readonly errorLevel?: LogLevel | false;
};

export type HttpServerObservabilitySpanOptions = {
  readonly name?: string | ((input: RequestObservabilityContextInput) => string);
  readonly attributes?: SpanAttributes | ((input: RequestObservabilityContextInput) => SpanAttributes);
};

export type HttpServerObservabilityOptions<A = unknown> = {
  readonly metrics?: MetricsRegistry | false;
  readonly logs?: false | HttpServerObservabilityLogOptions;
  readonly spans?: false | HttpServerObservabilitySpanOptions;
  readonly includeRouteLabel?: boolean;
  readonly clock?: () => number;
  readonly durationBuckets?: readonly number[];
  readonly statusCode?: (value: A) => number | undefined;
};

export type ObservedHttpServerResult<A> = {
  readonly value: A;
  readonly ctx: RequestObservabilityContext;
  readonly statusCode: number;
  readonly durationMs: number;
};

const DEFAULT_DURATION_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export async function runObservedHttpServerEffect<R extends object = {}, E = never, A = never>(
  observability: Observability,
  input: RequestObservabilityContextInput,
  effect: Async<R, E, A>,
  options: HttpServerObservabilityOptions<A> = {},
  env?: R,
  runtimeOptions?: RequestObservabilityRuntimeOptions<R>
): Promise<ObservedHttpServerResult<A>> {
  return observeHttpServerRequest(
    observability,
    input,
    async (ctx) => {
      const effectWithServerEvents = withServerSpanEvents(effect, options);
      const wrapped = options.spans === false
        ? effectWithServerEvents
        : ctx.span(serverSpanName(input, options), effectWithServerEvents, {
          ...ctx.attributes,
          ...serverSpanAttributes(input, options),
        });
      return ctx.run(wrapped as Async<R & any, E, A>, env, runtimeOptions);
    },
    options
  );
}

function withServerSpanEvents<R, E, A>(
  effect: Async<R, E, A>,
  options: HttpServerObservabilityOptions<A>
): Async<R, E, A> {
  return asyncFold(
    effect,
    (error) => asyncFlatMap(
      spanEvent("http.server.error", {
        "http.response.status_code": 500,
        "error.type": error instanceof Error ? error.name : typeof error,
      }),
      () => asyncFail(error)
    ),
    (value) => {
      const statusCode = options.statusCode?.(value) ?? 200;
      return asyncFlatMap(
        spanEvent("http.server.response", {
          "http.response.status_code": statusCode,
          "http.outcome": statusCode >= 500 ? "error" : "success",
        }),
        () => asyncSucceed(value)
      );
    }
  ) as Async<R, E, A>;
}

export async function observeHttpServerRequest<A>(
  observability: Observability,
  input: RequestObservabilityContextInput,
  handler: (ctx: RequestObservabilityContext) => Promise<A>,
  options: HttpServerObservabilityOptions<A> = {}
): Promise<ObservedHttpServerResult<A>> {
  const resolved = resolveServerOptions(observability, options);
  const ctx = makeRequestObservabilityContext(observability, input);
  const startedAt = resolved.clock();
  const baseLabels = requestBaseLabels(input, resolved);
  const inFlight = resolved.metrics?.gauge("brass_http_server_in_flight", baseLabels);
  inFlight?.increment();

  try {
    await ctx.run(logHttpServerRequest(input, resolved));
    const value = await handler(ctx);
    const statusCode = resolved.statusCode(value) ?? 200;
    const durationMs = finishServerObservation(startedAt, input, ctx.trace, statusCode, "success", resolved);
    await ctx.run(logHttpServerResponse(input, statusCode, durationMs, "success", resolved));
    return { value, ctx, statusCode, durationMs };
  } catch (error) {
    const durationMs = finishServerObservation(startedAt, input, ctx.trace, 500, "exception", resolved);
    await ctx.run(logHttpServerError(input, error, durationMs, resolved));
    throw error;
  } finally {
    if (inFlight && inFlight.value() > 0) inFlight.decrement();
  }
}

type ResolvedHttpServerOptions<A> = Required<Pick<
  HttpServerObservabilityOptions<A>,
  "clock" | "includeRouteLabel"
>> & {
  readonly metrics?: MetricsRegistry;
  readonly logs: false | HttpServerObservabilityLogOptions;
  readonly spans: false | HttpServerObservabilitySpanOptions;
  readonly durationBuckets?: readonly number[];
  readonly statusCode: (value: A) => number | undefined;
};

function resolveServerOptions<A>(
  observability: Observability,
  options: HttpServerObservabilityOptions<A>
): ResolvedHttpServerOptions<A> {
  return {
    metrics: options.metrics === false ? undefined : options.metrics ?? observability.metrics,
    logs: options.logs ?? {},
    spans: options.spans ?? {},
    includeRouteLabel: options.includeRouteLabel ?? true,
    clock: options.clock ?? Date.now,
    durationBuckets: options.durationBuckets,
    statusCode: options.statusCode ?? (() => undefined),
  };
}

function finishServerObservation<A>(
  startedAt: number,
  input: RequestObservabilityContextInput,
  trace: RequestObservabilityContext["trace"],
  statusCode: number,
  outcome: HttpServerOutcome,
  options: ResolvedHttpServerOptions<A>
): number {
  const durationMs = Math.max(0, options.clock() - startedAt);
  const labels = {
    ...requestBaseLabels(input, options),
    outcome: statusCode >= 500 ? "error" : outcome,
    status: String(statusCode),
  };

  options.metrics?.counter("brass_http_server_requests_total", labels).increment();
  options.metrics?.histogram("brass_http_server_duration_ms", [...(options.durationBuckets ?? DEFAULT_DURATION_BUCKETS)], labels).observe(
    durationMs,
    exemplarFromTraceContext(trace, durationMs, startedAt + durationMs),
  );
  return durationMs;
}

function logHttpServerRequest<A>(
  input: RequestObservabilityContextInput,
  options: ResolvedHttpServerOptions<A>
) {
  const level = options.logs === false ? false : options.logs.requestLevel ?? false;
  if (!level) return logNoop();
  return logEffect(level, "http.server.request", requestLogFields(input));
}

function logHttpServerResponse<A>(
  input: RequestObservabilityContextInput,
  statusCode: number,
  durationMs: number,
  outcome: HttpServerOutcome,
  options: ResolvedHttpServerOptions<A>
) {
  const configured = options.logs === false ? false : options.logs.responseLevel ?? false;
  const level = configured || (statusCode >= 500 ? (options.logs !== false ? options.logs.errorLevel ?? "warn" : false) : false);
  if (!level) return logNoop();
  return logEffect(level, "http.server.response", {
    ...requestLogFields(input),
    status: statusCode,
    outcome,
    durationMs,
  });
}

function logHttpServerError<A>(
  input: RequestObservabilityContextInput,
  error: unknown,
  durationMs: number,
  options: ResolvedHttpServerOptions<A>
) {
  const level = options.logs === false ? false : options.logs.errorLevel ?? "error";
  if (!level) return logNoop();
  return logEffect(level, "http.server.error", {
    ...requestLogFields(input),
    status: 500,
    outcome: "exception",
    durationMs,
    error: error instanceof Error ? error.message : String(error),
  });
}

function logNoop() {
  return asyncSucceed(undefined);
}

function serverSpanName<A>(
  input: RequestObservabilityContextInput,
  options: HttpServerObservabilityOptions<A>
): string {
  if (options.spans && options.spans.name) {
    return typeof options.spans.name === "function" ? options.spans.name(input) : options.spans.name;
  }
  return input.method && input.route ? `${input.method} ${input.route}` : input.route ?? "request";
}

function serverSpanAttributes<A>(
  input: RequestObservabilityContextInput,
  options: HttpServerObservabilityOptions<A>
): SpanAttributes {
  const spanOptions = options.spans === false ? {} : options.spans?.attributes;
  const custom = typeof spanOptions === "function" ? spanOptions(input) : spanOptions ?? {};
  return {
    "span.kind": "server",
    ...(input.method ? { "http.request.method": input.method } : {}),
    ...(input.route ? { "http.route": input.route } : {}),
    ...custom,
  };
}

function requestBaseLabels<A>(
  input: RequestObservabilityContextInput,
  options: Pick<ResolvedHttpServerOptions<A>, "includeRouteLabel">
): Record<string, string> {
  return compactLabels({
    method: input.method,
    ...(options.includeRouteLabel ? { route: input.route } : {}),
  });
}

function requestLogFields(input: RequestObservabilityContextInput): Record<string, unknown> {
  return {
    ...(input.method ? { method: input.method } : {}),
    ...(input.route ? { route: input.route } : {}),
    ...(input.target ? { target: input.target } : {}),
  };
}

function compactLabels(labels: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}
