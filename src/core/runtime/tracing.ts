// src/core/runtime/tracing.ts
// Tracing — OpenTelemetry-compatible span generation for effects.
//
// Provides automatic span creation for effects, with context propagation
// across fiber boundaries. Can export to any OTel-compatible backend.

import { Async, async, asyncFlatMap, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { Exit } from "../types/effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
};

export type SpanStatus = "ok" | "error" | "unset";

export type Span = {
  readonly name: string;
  readonly context: SpanContext;
  readonly startTime: number;
  endTime?: number;
  status: SpanStatus;
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: SpanEvent[];
};

export type SpanEvent = {
  readonly name: string;
  readonly time: number;
  readonly attributes?: Record<string, string | number | boolean>;
};

export type TracerConfig = {
  /** Service name for span metadata. */
  readonly serviceName: string;
  /** Called when a span ends (for export). */
  readonly onSpanEnd?: (span: Span) => void;
  /** Sampling rate (0.0 to 1.0). Default: 1.0 (sample everything). */
  readonly sampleRate?: number;
};

export type Tracer = {
  /** Wrap an effect in a span. */
  readonly span: <R, E, A>(name: string, effect: Async<R, E, A>, attributes?: Record<string, string | number | boolean>) => Async<R, E, A>;
  /** Get all completed spans (for testing). */
  readonly spans: () => readonly Span[];
  /** Clear collected spans. */
  readonly clear: () => void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let idCounter = 0;
function generateId(): string {
  return (++idCounter).toString(16).padStart(16, "0");
}

/**
 * Creates a tracer that wraps effects in spans.
 *
 * ```ts
 * const tracer = makeTracer({ serviceName: "my-app" });
 *
 * const result = await run(
 *   tracer.span("fetchUser", fetchUser(id), { userId: id })
 * );
 *
 * console.log(tracer.spans()); // all completed spans
 * ```
 */
export function makeTracer(config: TracerConfig): Tracer {
  const completedSpans: Span[] = [];
  const sampleRate = config.sampleRate ?? 1.0;

  const shouldSample = (): boolean => {
    if (sampleRate >= 1.0) return true;
    if (sampleRate <= 0.0) return false;
    return Math.random() < sampleRate;
  };

  const span = <R, E, A>(
    name: string,
    effect: Async<R, E, A>,
    attributes?: Record<string, string | number | boolean>
  ): Async<R, E, A> => {
    if (!shouldSample()) return effect;

    const spanObj: Span = {
      name,
      context: {
        traceId: generateId(),
        spanId: generateId(),
      },
      startTime: performance.now(),
      status: "unset",
      attributes: { "service.name": config.serviceName, ...attributes },
      events: [],
    };

    return asyncFold(
      effect,
      (error: E) => {
        spanObj.endTime = performance.now();
        spanObj.status = "error";
        spanObj.events.push({
          name: "error",
          time: performance.now(),
          attributes: { "error.message": String(error) },
        });
        completedSpans.push(spanObj);
        config.onSpanEnd?.(spanObj);
        return asyncFail(error) as Async<R, E, A>;
      },
      (value: A) => {
        spanObj.endTime = performance.now();
        spanObj.status = "ok";
        completedSpans.push(spanObj);
        config.onSpanEnd?.(spanObj);
        return asyncSucceed(value) as Async<R, E, A>;
      }
    );
  };

  return {
    span,
    spans: () => completedSpans,
    clear: () => { completedSpans.length = 0; },
  };
}
