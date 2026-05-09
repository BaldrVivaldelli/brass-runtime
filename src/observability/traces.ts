import { asyncFlatMap, asyncFold, asyncFail, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import type { Baggage, TraceContext } from "../core/runtime/contex";
import type { RuntimeSpan } from "../core/runtime/tracingSink";
import { getCurrentFiber } from "../core/runtime/fiber";
import { postOtlpJson, toOtlpAttributes, unixNanoFromMs, type OtlpExportOptions, type OtlpHttpExporterOptions } from "./metrics";
import { normalizeSpanId, normalizeTraceId } from "./traceContext";
import { shouldSampleWith } from "./sampling";

export type SpanAttributes = Record<string, string | number | boolean>;

export type SpanLink = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceState?: string;
  readonly attributes?: SpanAttributes;
};

export type SpanOptions = {
  readonly attributes?: SpanAttributes;
  readonly links?: readonly SpanLink[];
};

export type SpanSource = {
  readonly exportFinished: () => readonly RuntimeSpan[];
} | (() => readonly RuntimeSpan[]);

export function withSpan<R, E, A>(
  name: string,
  effect: Async<R, E, A>,
  attributesOrOptions?: SpanAttributes | SpanOptions
): Async<R, E, A> {
  const options = resolveSpanOptions(attributesOrOptions);
  return asyncFlatMap(startSpan(name, options), (state) =>
    asyncFold(
      effect,
      (error: E) => asyncFlatMap(endSpan(state, "failure", error), () => asyncFail(error)),
      (value: A) => asyncFlatMap(endSpan(state, "success"), () => asyncSucceed(value))
    )
  ) as Async<R, E, A>;
}

export function spanLink(trace: TraceContext, attributes?: SpanAttributes): SpanLink {
  return {
    traceId: trace.traceId,
    spanId: trace.spanId,
    ...(trace.traceState ? { traceState: trace.traceState } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

export function currentSpanLink(attributes?: SpanAttributes): SpanLink | undefined {
  const fiber = getCurrentFiber() as any;
  const trace = fiber?.fiberContext?.trace;
  return trace?.traceId && trace?.spanId ? spanLink(trace, attributes) : undefined;
}

export function withBaggage<R, E, A>(
  baggage: Baggage,
  effect: Async<R, E, A>
): Async<R, E, A> {
  return asyncFlatMap(startBaggage(baggage), (state) =>
    asyncFold(
      effect,
      (error: E) => asyncFlatMap(endBaggage(state), () => asyncFail(error)),
      (value: A) => asyncFlatMap(endBaggage(state), () => asyncSucceed(value))
    )
  ) as Async<R, E, A>;
}

export function currentBaggage(): Baggage | undefined {
  const fiber = getCurrentFiber() as any;
  const baggage = fiber?.fiberContext?.trace?.baggage;
  return baggage ? { ...baggage } : undefined;
}

export function spanEvent(name: string, attributes: SpanAttributes = {}): Async<unknown, never, void> {
  return asyncSync(() => {
    const fiber = getCurrentFiber() as any;
    const trace = fiber?.fiberContext?.trace;
    if (!fiber?.runtime || !trace || trace.sampled === false) return;

    fiber.runtime.hooks.emit(
      { type: "span.event", name, attributes },
      spanContext(fiber, trace)
    );
  }) as Async<unknown, never, void>;
}

export function spansToOtlp(spans: readonly RuntimeSpan[], options: OtlpExportOptions = {}) {
  const scope: Record<string, unknown> = { name: options.scopeName ?? "brass-runtime" };
  if (options.scopeVersion) scope.version = options.scopeVersion;

  return {
    resourceSpans: [{
      resource: { attributes: toOtlpAttributes(options.resource ?? {}) },
      scopeSpans: [{
        scope,
        spans: spans.map(spanToOtlp),
      }],
    }],
  };
}

export function makeOtlpHttpSpanExporter(source: SpanSource, options: OtlpHttpExporterOptions) {
  return {
    export: async () => {
      const spans = typeof source === "function" ? source() : source.exportFinished();
      const body = JSON.stringify(spansToOtlp(spans, options));
      const response = await postOtlpJson(options, body);
      return { status: response.status, body };
    },
  };
}

type SpanState = {
  readonly fiber: any;
  readonly runtime: any;
  readonly previousTrace: TraceContext | null;
  readonly trace: TraceContext;
  readonly name: string;
  readonly options: ResolvedSpanOptions;
  readonly forceSampleOnError: boolean;
  startEmitted: boolean;
  ended: boolean;
};

type ResolvedSpanOptions = {
  readonly attributes: SpanAttributes;
  readonly links: readonly SpanLink[];
};

function startSpan(name: string, options: ResolvedSpanOptions): Async<unknown, never, SpanState | undefined> {
  return asyncSync(() => {
    const fiber = getCurrentFiber() as any;
    const runtime = fiber?.runtime;
    if (!fiber?.fiberContext || !runtime) return undefined;

    const previousTrace = fiber.fiberContext.trace ?? null;
    const tracer = resolveTracer(runtime);
    const traceId = previousTrace?.traceId ?? tracer.newTraceId();
    const sampled = decideSampling(runtime, {
      traceId,
      spanName: name,
      parentSampled: previousTrace?.sampled,
      attributes: options.attributes,
    });
    const trace: TraceContext = {
      traceId,
      spanId: tracer.newSpanId(),
      parentSpanId: previousTrace?.spanId,
      sampled,
      traceState: previousTrace?.traceState,
      ...(previousTrace?.baggage ? { baggage: previousTrace.baggage } : {}),
    };

    const state: SpanState = {
      fiber,
      runtime,
      previousTrace,
      trace,
      name,
      options,
      forceSampleOnError: runtime?.env?.brass?.forceSampleOnError === true,
      startEmitted: sampled !== false,
      ended: false,
    };

    fiber.fiberContext = { ...fiber.fiberContext, trace };
    fiber.addFinalizer?.((exit: any) => {
      const status = exit?._tag === "Success"
        ? "success"
        : exit?.cause?._tag === "Interrupt"
          ? "interrupted"
          : "failure";
      finishSpan(state, status, exit?._tag === "Failure" ? exit.cause : undefined);
    });

    if (state.startEmitted) {
      runtime.hooks.emit(
        { type: "span.start", name, attributes: options.attributes, links: options.links.map(normalizeSpanLink) },
        spanContext(fiber, trace)
      );
    }

    return state;
  }) as Async<unknown, never, SpanState | undefined>;
}

function endSpan(
  state: SpanState | undefined,
  status: "success" | "failure" | "interrupted",
  error?: unknown
): Async<unknown, never, void> {
  return asyncSync(() => finishSpan(state, status, error)) as Async<unknown, never, void>;
}

function finishSpan(
  state: SpanState | undefined,
  status: "success" | "failure" | "interrupted",
  error?: unknown
): void {
  if (!state || state.ended) return;
  state.ended = true;

  if (!state.startEmitted && status === "failure" && state.forceSampleOnError) {
    state.trace.sampled = true;
    state.startEmitted = true;
    state.runtime.hooks.emit(
      { type: "span.start", name: state.name, attributes: state.options.attributes, links: state.options.links.map(normalizeSpanLink) },
      spanContext(state.fiber, state.trace)
    );
  }

  if (state.startEmitted) {
    state.runtime.hooks.emit(
      { type: "span.end", name: state.name, status, error },
      spanContext(state.fiber, state.trace)
    );
  }

  if (state.fiber?.fiberContext) {
    state.fiber.fiberContext = { ...state.fiber.fiberContext, trace: state.previousTrace };
  }
}

function spanContext(fiber: any, trace: TraceContext) {
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

type BaggageState = {
  readonly fiber: any;
  readonly previousTrace: TraceContext | null;
  ended: boolean;
};

function startBaggage(baggage: Baggage): Async<unknown, never, BaggageState | undefined> {
  return asyncSync(() => {
    const fiber = getCurrentFiber() as any;
    if (!fiber?.fiberContext) return undefined;
    const previousTrace = fiber.fiberContext.trace ?? null;
    if (!previousTrace) return undefined;
    const state: BaggageState = { fiber, previousTrace, ended: false };
    fiber.fiberContext = {
      ...fiber.fiberContext,
      trace: {
        ...previousTrace,
        baggage: {
          ...(previousTrace.baggage ?? {}),
          ...baggage,
        },
      },
    };
    fiber.addFinalizer?.(() => restoreBaggage(state));
    return state;
  }) as Async<unknown, never, BaggageState | undefined>;
}

function endBaggage(state: BaggageState | undefined): Async<unknown, never, void> {
  return asyncSync(() => restoreBaggage(state)) as Async<unknown, never, void>;
}

function restoreBaggage(state: BaggageState | undefined): void {
  if (!state || state.ended) return;
  state.ended = true;
  if (state.fiber?.fiberContext) {
    state.fiber.fiberContext = { ...state.fiber.fiberContext, trace: state.previousTrace };
  }
}

function decideSampling(
  runtime: any,
  input: {
    readonly traceId: string;
    readonly spanName: string;
    readonly parentSampled?: boolean;
    readonly attributes: SpanAttributes;
  }
): boolean {
  const brass = runtime?.env?.brass;
  if (input.parentSampled === false && brass?.respectRemoteSampled !== false) return false;
  return shouldSampleWith(brass?.sampler, input);
}

function resolveTracer(runtime: any) {
  const tracer = runtime?.env?.brass?.tracer;
  if (tracer?.newTraceId && tracer?.newSpanId) return tracer;
  return {
    newTraceId: () => randomRuntimeId("trace"),
    newSpanId: () => randomRuntimeId("span"),
  };
}

function spanToOtlp(span: RuntimeSpan) {
  const status = inferOtlpStatus(span);
  return {
    traceId: normalizeTraceId(span.traceId),
    spanId: normalizeSpanId(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: normalizeSpanId(span.parentSpanId) } : {}),
    ...(span.traceState ? { traceState: span.traceState } : {}),
    name: span.name,
    kind: spanKind(span),
    startTimeUnixNano: unixNanoFromMs(span.startWallTs),
    endTimeUnixNano: unixNanoFromMs(span.endWallTs ?? span.startWallTs),
    attributes: toOtlpAttributes(normalizeAttributes(span.attrs)),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: unixNanoFromMs(event.wallTs),
      attributes: toOtlpAttributes(normalizeAttributes(event.attrs)),
    })),
    links: (span.links ?? []).map((link) => ({
      traceId: normalizeTraceId(link.traceId),
      spanId: normalizeSpanId(link.spanId),
      ...(link.traceState ? { traceState: link.traceState } : {}),
      attributes: toOtlpAttributes(normalizeAttributes(link.attributes)),
    })),
    status,
  };
}

function spanKind(span: RuntimeSpan): number {
  const kind = span.attrs["span.kind"];
  if (kind === "server") return 2;
  if (kind === "client") return 3;
  if (kind === "producer") return 4;
  if (kind === "consumer") return 5;
  if (typeof kind === "number" && Number.isInteger(kind) && kind >= 1 && kind <= 5) return kind;
  return 1;
}

function resolveSpanOptions(input: SpanAttributes | SpanOptions | undefined): ResolvedSpanOptions {
  if (!input) return { attributes: {}, links: [] };
  if ("attributes" in input || "links" in input) {
    const options = input as SpanOptions;
    return {
      attributes: options.attributes ?? {},
      links: options.links ?? [],
    };
  }
  return { attributes: input as SpanAttributes, links: [] };
}

function normalizeSpanLink(link: SpanLink): SpanLink {
  return {
    traceId: link.traceId,
    spanId: link.spanId,
    ...(link.traceState ? { traceState: link.traceState } : {}),
    ...(link.attributes ? { attributes: link.attributes } : {}),
  };
}

function inferOtlpStatus(span: RuntimeSpan) {
  const end = [...span.events].reverse().find((event) => event.name === "span.end" || event.name === "fiber.end");
  const status = typeof end?.attrs === "object" && end.attrs != null ? (end.attrs as any).status : undefined;
  if (status === "failure" || status === "interrupted") {
    return { code: 2, message: status };
  }
  if (status === "success") return { code: 1 };
  return { code: 0 };
}

function normalizeAttributes(attrs: unknown): SpanAttributes {
  if (!attrs || typeof attrs !== "object") return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}

function randomRuntimeId(prefix: string): string {
  const cryptoLike = (globalThis as any).crypto;
  if (typeof cryptoLike?.randomUUID === "function") return cryptoLike.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
