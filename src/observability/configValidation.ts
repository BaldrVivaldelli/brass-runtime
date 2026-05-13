import { Schema, parseConfig } from "../schema";
import type { HttpObservabilityOptions } from "./http";
import type { ObservabilityOptions } from "./setup";

const fn = Schema.custom<Function>((value): value is Function => typeof value === "function", "function");
const object = Schema.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value),
  "object",
);
const falseOrObject = Schema.union([Schema.literal(false), object]);
const ratio = Schema.number({ min: 0, max: 1 });
const logLevel = Schema.enum(["debug", "info", "warn", "error"] as const);

const retryOptions = Schema.object({
  attempts: Schema.number({ min: 0, int: true }).optional(),
  initialDelayMs: Schema.number({ min: 0, int: true }).optional(),
  maxDelayMs: Schema.number({ min: 0, int: true }).optional(),
  jitterRatio: Schema.number({ min: 0, max: 1 }).optional(),
  sleep: fn.optional(),
}, { unknownKeys: "passthrough" });

const pipelineOptions = Schema.object({
  maxQueueSize: Schema.number({ min: 0, int: true }).optional(),
  batchSize: Schema.number({ min: 1, int: true }).optional(),
  timeoutMs: Schema.number({ min: 0, int: true }).optional(),
  retry: retryOptions.optional(),
  dropPolicy: Schema.enum(["drop-oldest", "drop-newest"] as const).optional(),
  shutdownTimeoutMs: Schema.number({ min: 0, int: true }).optional(),
}, { unknownKeys: "passthrough" });

const otlpOptions = Schema.object({
  metricsUrl: Schema.string().optional(),
  tracesUrl: Schema.string().optional(),
  logsUrl: Schema.string().optional(),
  headers: Schema.record(Schema.string()).optional(),
  fetch: fn.optional(),
  timeoutMs: Schema.number({ min: 1, int: true }).optional(),
  retry: retryOptions.optional(),
  pipeline: pipelineOptions.optional(),
}, { unknownKeys: "passthrough" });

const samplingOptions = Schema.union([
  Schema.literal(false),
  ratio,
  fn,
  Schema.object({
    ratio: ratio.optional(),
    rules: Schema.array(object).optional(),
    sampler: Schema.union([fn, object]).optional(),
    respectRemoteSampled: Schema.boolean().optional(),
    forceSampleOnError: Schema.boolean().optional(),
  }, { unknownKeys: "passthrough" }),
]);

const observabilityOptions = Schema.object({
  serviceName: Schema.string({ minLength: 1 }).optional(),
  serviceVersion: Schema.string({ minLength: 1 }).optional(),
  resource: object.optional(),
  eventBus: object.optional(),
  metrics: falseOrObject.optional(),
  logs: falseOrObject.optional(),
  traces: falseOrObject.optional(),
  sampling: samplingOptions.optional(),
  redaction: falseOrObject.optional(),
  cardinality: Schema.union([
    Schema.literal(false),
    Schema.object({
      maxValuesPerLabel: Schema.number({ min: 1, int: true }).optional(),
      overflowValue: Schema.string({ minLength: 1 }).optional(),
    }, { unknownKeys: "passthrough" }),
  ]).optional(),
  otlp: otlpOptions.optional(),
  flushIntervalMs: Schema.number({ min: 1, int: true }).optional(),
  autoStart: Schema.boolean().optional(),
  traceSeed: object.optional(),
  childName: fn.optional(),
  onFlushError: fn.optional(),
}, { unknownKeys: "passthrough" });

const httpObservabilityOptions = Schema.object({
  metrics: falseOrObject.optional(),
  logs: Schema.union([
    Schema.literal(false),
    Schema.object({
      requestLevel: Schema.union([logLevel, Schema.literal(false)]).optional(),
      responseLevel: Schema.union([logLevel, Schema.literal(false)]).optional(),
      errorLevel: Schema.union([logLevel, Schema.literal(false)]).optional(),
    }, { unknownKeys: "passthrough" }),
  ]).optional(),
  spans: Schema.union([
    Schema.literal(false),
    Schema.object({
      name: Schema.union([Schema.string({ minLength: 1 }), fn]).optional(),
      attributes: Schema.union([object, fn]).optional(),
      events: Schema.boolean().optional(),
    }, { unknownKeys: "passthrough" }),
  ]).optional(),
  adaptiveLimiter: Schema.union([
    Schema.boolean(),
    Schema.object({
      enabled: Schema.boolean().optional(),
      includeKeyLabel: Schema.boolean().optional(),
    }, { unknownKeys: "passthrough" }),
  ]).optional(),
  policy: Schema.union([
    Schema.boolean(),
    Schema.object({
      enabled: Schema.boolean().optional(),
      labelKeys: Schema.array(Schema.enum(["preset", "lane", "poolKey", "dedupKey", "priority", "retry"] as const)).optional(),
    }, { unknownKeys: "passthrough" }),
  ]).optional(),
  injectTraceHeaders: Schema.boolean().optional(),
  includeHostLabel: Schema.boolean().optional(),
  route: Schema.union([Schema.string({ minLength: 1 }), fn]).optional(),
  clock: fn.optional(),
  durationBuckets: Schema.array(Schema.number({ min: 0 }).refine((n) => n > 0, "duration bucket must be > 0")).optional(),
}, { unknownKeys: "passthrough" });

export function validateObservabilityOptions(options: ObservabilityOptions): void {
  parseConfig("ObservabilityOptions", observabilityOptions, options);
}

export function validateHttpObservabilityOptions(options: HttpObservabilityOptions): void {
  parseConfig("HttpObservabilityOptions", httpObservabilityOptions, options);
}
