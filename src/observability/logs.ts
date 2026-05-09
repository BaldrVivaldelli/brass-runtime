import { asyncFlatMap, asyncFold, asyncFail, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import { ctxExtend, ctxToObject, emptyContext, type ContextNode, type JSONValue } from "../core/runtime/contex";
import type { RuntimeHooks } from "../core/runtime/events";
import { getCurrentFiber } from "../core/runtime/fiber";
import { makeObservabilityRedactor, type RedactionConfig } from "./redaction";
import { postOtlpJson, toOtlpAttributes, unixNanoFromMs, type OtlpExportOptions, type OtlpHttpExporterOptions } from "./metrics";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type StructuredLogRecord = {
  readonly ts: string;
  readonly wallTs: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Record<string, unknown>;
  readonly fiberId?: number;
  readonly scopeId?: number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly traceState?: string;
};

export type StructuredLogSinkOptions = {
  readonly minLevel?: LogLevel;
  readonly clock?: () => number;
  readonly write?: (record: StructuredLogRecord) => void;
  readonly redact?: RedactionConfig;
};

export type StructuredLogSource = {
  readonly exportRecords: () => readonly StructuredLogRecord[];
} | (() => readonly StructuredLogRecord[]);

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function makeStructuredLogSink(options: StructuredLogSinkOptions = {}): RuntimeHooks {
  const minLevel = options.minLevel ?? "debug";
  const clock = options.clock ?? Date.now;
  const write = options.write ?? defaultStructuredLogWriter;
  const redactor = makeObservabilityRedactor(options.redact);

  return {
    emit(ev, ctx) {
      if (ev.type !== "log") return;
      if (LEVEL_WEIGHT[ev.level] < LEVEL_WEIGHT[minLevel]) return;

      const wallTs = clock();
      try {
        write({
          ts: new Date(wallTs).toISOString(),
          wallTs,
          level: ev.level,
          message: ev.message,
          fields: redactor.fields(ev.fields ?? {}),
          fiberId: ctx.fiberId,
          scopeId: ctx.scopeId,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: ctx.parentSpanId,
          traceState: ctx.traceState,
        });
      } catch {
        // Logging sinks are observational and must not change effect semantics.
      }
    },
  };
}

export function formatStructuredLog(record: StructuredLogRecord): string {
  return JSON.stringify(record);
}

export function structuredLogsToOtlp(records: readonly StructuredLogRecord[], options: OtlpExportOptions = {}) {
  const scope: Record<string, unknown> = { name: options.scopeName ?? "brass-runtime" };
  if (options.scopeVersion) scope.version = options.scopeVersion;

  return {
    resourceLogs: [{
      resource: { attributes: toOtlpAttributes(options.resource ?? {}) },
      scopeLogs: [{
        scope,
        logRecords: records.map(logRecordToOtlp),
      }],
    }],
  };
}

export function makeOtlpHttpLogExporter(source: StructuredLogSource, options: OtlpHttpExporterOptions) {
  return {
    export: async () => {
      const records = typeof source === "function" ? source() : source.exportRecords();
      const body = JSON.stringify(structuredLogsToOtlp(records, options));
      const response = await postOtlpJson(options, body);
      return { status: response.status, body, logCount: records.length };
    },
  };
}

export function logEffect(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {}
): Async<unknown, never, void> {
  return asyncSync(() => {
    const fiber = getCurrentFiber() as any;
    const runtime = fiber?.runtime;
    if (!runtime) return;

    const inherited = fiber.fiberContext?.log ? ctxToObject(fiber.fiberContext.log) : {};
    runtime.log(level, message, { ...inherited, ...fields });
  }) as Async<unknown, never, void>;
}

export function withLogContext<R, E, A>(
  patch: Record<string, JSONValue>,
  effect: Async<R, E, A>
): Async<R, E, A> {
  return asyncFlatMap(startLogContext(patch), (state) =>
    asyncFold(
      effect,
      (error: E) => asyncFlatMap(endLogContext(state), () => asyncFail(error)),
      (value: A) => asyncFlatMap(endLogContext(state), () => asyncSucceed(value))
    )
  ) as Async<R, E, A>;
}

type LogContextState = {
  readonly fiber: any;
  readonly previous: ContextNode;
  ended: boolean;
};

function startLogContext(patch: Record<string, JSONValue>): Async<unknown, never, LogContextState | undefined> {
  return asyncSync(() => {
    const fiber = getCurrentFiber() as any;
    if (!fiber?.fiberContext) return undefined;

    const previous = fiber.fiberContext.log ?? emptyContext;
    const state: LogContextState = { fiber, previous, ended: false };
    fiber.fiberContext = { ...fiber.fiberContext, log: ctxExtend(previous, patch) };
    fiber.addFinalizer?.(() => restoreLogContext(state));
    return state;
  }) as Async<unknown, never, LogContextState | undefined>;
}

function endLogContext(state: LogContextState | undefined): Async<unknown, never, void> {
  return asyncSync(() => restoreLogContext(state)) as Async<unknown, never, void>;
}

function restoreLogContext(state: LogContextState | undefined): void {
  if (!state || state.ended) return;
  state.ended = true;
  if (state.fiber?.fiberContext) {
    state.fiber.fiberContext = { ...state.fiber.fiberContext, log: state.previous };
  }
}

export function defaultStructuredLogWriter(record: StructuredLogRecord): void {
  const line = formatStructuredLog(record);
  if (record.level === "error") console.error(line);
  else console.log(line);
}

function logRecordToOtlp(record: StructuredLogRecord) {
  return {
    timeUnixNano: unixNanoFromMs(record.wallTs),
    severityText: record.level.toUpperCase(),
    severityNumber: severityNumber(record.level),
    body: { stringValue: record.message },
    ...(record.traceId ? { traceId: record.traceId } : {}),
    ...(record.spanId ? { spanId: record.spanId } : {}),
    attributes: toOtlpAttributes(normalizeLogAttributes({
      ...record.fields,
      ...(record.fiberId !== undefined ? { "brass.fiber_id": record.fiberId } : {}),
      ...(record.scopeId !== undefined ? { "brass.scope_id": record.scopeId } : {}),
      ...(record.parentSpanId ? { "brass.parent_span_id": record.parentSpanId } : {}),
      ...(record.traceState ? { "w3c.tracestate": record.traceState } : {}),
    })),
  };
}

function severityNumber(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 5;
    case "info":
      return 9;
    case "warn":
      return 13;
    case "error":
      return 17;
  }
}

function normalizeLogAttributes(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value != null) {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}
