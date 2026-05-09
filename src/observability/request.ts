import type { Baggage, TraceContext } from "../core/runtime/contex";
import { Runtime, type RuntimeOptions } from "../core/runtime/runtime";
import type { Async } from "../core/types/asyncEffect";
import type {
  Observability,
  ObservabilityFlushResult,
  ObservabilityRuntimeEnv,
} from "./setup";
import { resolveRequestTraceSeed } from "./setup";
import { withSpan, type SpanAttributes } from "./traces";
import type { TraceContextCarrier } from "./traceContext";

export type RequestObservabilityContextInput = {
  readonly headers?: TraceContextCarrier;
  readonly trace?: TraceContext;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: Baggage | string;
  readonly method?: string;
  readonly target?: string;
  readonly route?: string;
  readonly spanName?: string;
  readonly attributes?: SpanAttributes;
};

export type RequestObservabilityRuntimeOptions<R extends object> = Omit<
  RuntimeOptions<R & ObservabilityRuntimeEnv>,
  "env" | "hooks"
>;

export type RequestObservabilityContext = {
  readonly env: ObservabilityRuntimeEnv;
  readonly trace?: TraceContext;
  readonly route?: string;
  readonly attributes: SpanAttributes;
  readonly makeRuntime: <R extends object = {}>(
    env?: R,
    options?: RequestObservabilityRuntimeOptions<R>
  ) => Runtime<R & ObservabilityRuntimeEnv>;
  readonly run: <R extends object = {}, E = never, A = never>(
    effect: Async<R & ObservabilityRuntimeEnv, E, A>,
    env?: R,
    options?: RequestObservabilityRuntimeOptions<R>
  ) => Promise<A>;
  readonly span: <R, E, A>(
    name: string,
    effect: Async<R, E, A>,
    attributes?: SpanAttributes
  ) => Async<R, E, A>;
  readonly withRequestSpan: <R, E, A>(
    effect: Async<R, E, A>,
    attributes?: SpanAttributes
  ) => Async<R, E, A>;
  readonly flush: () => Promise<ObservabilityFlushResult>;
  readonly shutdown: () => Promise<ObservabilityFlushResult>;
};

export function makeRequestObservabilityContext(
  observability: Observability,
  input: RequestObservabilityContextInput = {}
): RequestObservabilityContext {
  const trace = resolveRequestTraceSeed(input);
  const env = observability.envForRequest(input);
  const attributes = requestSpanAttributes(input);
  const defaultSpanName = input.spanName
    ?? (input.method && input.route ? `${input.method} ${input.route}` : input.route ?? "request");

  const makeRuntime = <R extends object = {}>(
    extraEnv?: R,
    options: RequestObservabilityRuntimeOptions<R> = {}
  ): Runtime<R & ObservabilityRuntimeEnv> =>
    new Runtime({
      ...options,
      env: mergeEnv(extraEnv, env),
      hooks: observability.hooks,
    });

  return {
    env,
    trace,
    route: input.route,
    attributes,
    makeRuntime,
    run: (effect, extraEnv, options) => makeRuntime(extraEnv, options).toPromise(effect),
    span: (name, effect, spanAttributes) => withSpan(name, effect, spanAttributes),
    withRequestSpan: (effect, spanAttributes) =>
      withSpan(defaultSpanName, effect, { ...attributes, ...(spanAttributes ?? {}) }),
    flush: observability.flush,
    shutdown: observability.shutdown,
  };
}

function mergeEnv<R extends object>(
  extraEnv: R | undefined,
  observabilityEnv: ObservabilityRuntimeEnv
): R & ObservabilityRuntimeEnv {
  return Object.assign({}, extraEnv ?? {}, observabilityEnv) as R & ObservabilityRuntimeEnv;
}

function requestSpanAttributes(input: RequestObservabilityContextInput): SpanAttributes {
  return {
    "span.kind": "server",
    ...(input.method ? { "http.method": input.method } : {}),
    ...(input.method ? { "http.request.method": input.method } : {}),
    ...(input.target ? { "http.target": input.target } : {}),
    ...(input.target ? { "url.path": targetPath(input.target) } : {}),
    ...(input.route ? { "http.route": input.route } : {}),
    ...(input.attributes ?? {}),
  };
}

function targetPath(target: string): string {
  try {
    return new URL(target, "http://local").pathname;
  } catch {
    return target.split("?", 1)[0] ?? target;
  }
}
