import { Schema, parseConfig } from "../schema";
import type { DefaultHttpClientConfig } from "./defaultClient";
import type { LifecycleClientConfig } from "./lifecycle/types";
import type { MakeHttpConfig } from "./client";

const fn = Schema.custom<Function>((value): value is Function => typeof value === "function", "function");
const object = Schema.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value),
  "object",
);
const keyResolver = Schema.union([
  Schema.enum(["global", "origin", "host"] as const),
  fn,
]);

const headroomStrategyConfig = Schema.union([
  Schema.number({ min: 1 }),
  Schema.enum(["fixed", "proportional"] as const),
  fn,
  Schema.object({
    type: Schema.literal("fixed"),
    value: Schema.number({ min: 1 }).optional(),
  }, { unknownKeys: "passthrough" }),
  Schema.object({
    type: Schema.literal("proportional"),
    ratio: Schema.number({ min: 0 }).refine((n) => n > 0, "ratio must be > 0").optional(),
    min: Schema.number({ min: 1 }).optional(),
    max: Schema.number({ min: 1 }).optional(),
  }, { unknownKeys: "passthrough" }),
]);

const poolConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    concurrency: Schema.number({ min: 1, int: true }).optional(),
    maxQueue: Schema.number({ min: 0, int: true }).optional(),
    queueTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
    key: keyResolver.optional(),
    engine: Schema.enum(["ts", "wasm"] as const).optional(),
    wasm: Schema.boolean().optional(),
  }, { unknownKeys: "passthrough" }),
]);

const adaptiveLimiterConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    preset: Schema.enum(["conservative", "balanced", "aggressive"] as const).optional(),
    initialLimit: Schema.number({ min: 1, int: true }).optional(),
    minLimit: Schema.number({ min: 1, int: true }).optional(),
    maxLimit: Schema.number({ min: 1, int: true }).optional(),
    smoothingFactor: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "smoothingFactor must be in (0, 1]").optional(),
    probeInterval: Schema.number({ min: 1, int: true }).optional(),
    probeJitterRatio: Schema.number({ min: 0, max: 1 }).optional(),
    windowSize: Schema.number({ min: 2, int: true }).optional(),
    minSamples: Schema.number({ min: 1, int: true }).optional(),
    baselineStrategy: Schema.enum(["min", "p5", "ema-low"] as const).optional(),
    decreaseCooldownSamples: Schema.number({ min: 0, int: true }).optional(),
    historySize: Schema.number({ min: 0, int: true }).optional(),
    windowDecayFactor: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "windowDecayFactor must be in (0, 1]").optional(),
    errorWeight: Schema.number({ min: 0, max: 1 }).optional(),
    errorSmoothingFactor: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "errorSmoothingFactor must be in (0, 1]").optional(),
    errorStatusThreshold: Schema.number({ min: 100, max: 599, int: true }).optional(),
    queueStrategy: Schema.enum(["fifo", "priority"] as const).optional(),
    queueLoadShedding: Schema.enum(["reject-new", "priority-evict"] as const).optional(),
    rejectionBackoffThreshold: Schema.number({ min: 1, int: true }).optional(),
    rejectionBackoffMs: Schema.number({ min: 1, int: true }).optional(),
    stateTtlMs: Schema.union([Schema.literal(false), Schema.number({ min: 1, int: true })]).optional(),
    warmupRequests: Schema.number({ min: 0, int: true }).optional(),
    decreaseThreshold: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "decreaseThreshold must be in (0, 1]").optional(),
    increaseThreshold: Schema.number({ min: 1 }).optional(),
    maxDecreaseRatio: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "maxDecreaseRatio must be in (0, 1]").optional(),
    headroomStrategy: headroomStrategyConfig.optional(),
    slowStartRecovery: Schema.boolean().optional(),
    slowStartSaturationThreshold: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "slowStartSaturationThreshold must be in (0, 1]").optional(),
    slowStartSaturationSamples: Schema.number({ min: 1, int: true }).optional(),
    key: keyResolver.optional(),
    maxQueue: Schema.number({ min: 0, int: true }).optional(),
    queueTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
    onLimitChange: fn.optional(),
    percentile: Schema.enum(["p50", "p99"] as const).optional(),
  }, { unknownKeys: "passthrough" }),
]);

const cacheConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    ttlSeconds: Schema.number({ min: 1, int: true }).optional(),
    maxEntries: Schema.number({ min: 1, int: true }).optional(),
    staleWhileRevalidate: Schema.boolean().optional(),
    cachePolicy: fn.optional(),
    cacheRelevantHeaders: Schema.array(Schema.string()).optional(),
    onEvent: fn.optional(),
    onLifecycleEvent: fn.optional(),
  }, { unknownKeys: "passthrough" }),
]);

const priorityConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    concurrency: Schema.number({ min: 1, int: true }).optional(),
    queueTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
    onEvent: fn.optional(),
  }, { unknownKeys: "passthrough" }),
]);

const retryConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    maxRetries: Schema.number({ min: 0, int: true }).optional(),
    baseDelayMs: Schema.number({ min: 0, int: true }).optional(),
    maxDelayMs: Schema.number({ min: 0, int: true }).optional(),
    maxElapsedMs: Schema.number({ min: 1, int: true }).optional(),
    respectRetryAfter: Schema.boolean().optional(),
    retryOnMethods: Schema.array(Schema.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const)).optional(),
    retryOnStatus: fn.optional(),
    retryOnError: fn.optional(),
    engine: Schema.enum(["ts", "wasm"] as const).optional(),
    wasm: Schema.boolean().optional(),
    onRetry: fn.optional(),
  }, { unknownKeys: "passthrough" }),
]);

const requestRetryOverrideConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    maxRetries: Schema.number({ min: 0, int: true }).optional(),
    baseDelayMs: Schema.number({ min: 0, int: true }).optional(),
    maxDelayMs: Schema.number({ min: 0, int: true }).optional(),
    schedule: object.optional(),
    retryOnStatus: fn.optional(),
  }, { unknownKeys: "passthrough" }),
]);

const requestPolicyConfig = Schema.object({
  preset: Schema.string({ minLength: 1 }).optional(),
  lane: Schema.string({ minLength: 1 }).optional(),
  dedupKey: Schema.string({ minLength: 1 }).optional(),
  priority: Schema.number({ min: 0, max: 9, int: true }).optional(),
  retry: requestRetryOverrideConfig.optional(),
  poolKey: Schema.string({ minLength: 1 }).optional(),
}, { unknownKeys: "passthrough" });

const policyPresetsConfig = Schema.record(Schema.union([requestPolicyConfig, fn]));

const compressionConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    encodings: Schema.array(Schema.enum(["gzip", "br", "deflate"] as const)).optional(),
  }, { unknownKeys: "passthrough" }),
]);

const prewarmConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    origins: Schema.array(Schema.string()).optional(),
    afterResponse: fn.optional(),
    keepAliveDurationMs: Schema.number({ min: 1, int: true }).optional(),
    budget: Schema.number({ min: 1, int: true }).optional(),
    probeTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
    autoRefresh: Schema.boolean().optional(),
    useClientPool: Schema.boolean().optional(),
    onEvent: fn.optional(),
  }, { unknownKeys: "passthrough" }),
]);

const batchConfig = Schema.union([
  Schema.literal(false),
  Schema.object({
    batch: object,
    windowMs: Schema.number({ min: 1, int: true }),
    maxBatchSize: Schema.number({ min: 2, int: true }),
    batchKey: fn,
  }, { unknownKeys: "passthrough" }),
]);

const wireConfig = Schema.object({
  baseUrl: Schema.string().optional(),
  headers: Schema.record(Schema.string()).optional(),
  timeoutMs: Schema.number({ min: 1, int: true }).optional(),
  transport: fn.optional(),
  streamTransport: fn.optional(),
  pool: poolConfig.optional(),
  adaptiveLimiter: adaptiveLimiterConfig.optional(),
}, { unknownKeys: "passthrough" });

const lifecycleConfig = Schema.object({
  baseUrl: Schema.string().optional(),
  headers: Schema.record(Schema.string()).optional(),
  timeoutMs: Schema.number({ min: 1, int: true }).optional(),
  transport: fn.optional(),
  streamTransport: fn.optional(),
  pool: poolConfig.optional(),
  adaptiveLimiter: adaptiveLimiterConfig.optional(),
  dedup: Schema.union([Schema.literal(false), object]).optional(),
  batch: batchConfig.optional(),
  cache: cacheConfig.optional(),
  priority: priorityConfig.optional(),
  retry: retryConfig.optional(),
  prewarm: prewarmConfig.optional(),
  onEvent: fn.optional(),
  policyPresets: policyPresetsConfig.optional(),
}, { unknownKeys: "passthrough" });

const defaultClientConfig = Schema.object({
  baseUrl: Schema.string().optional(),
  headers: Schema.record(Schema.string()).optional(),
  timeoutMs: Schema.number({ min: 1, int: true }).optional(),
  transport: fn.optional(),
  streamTransport: fn.optional(),
  pool: poolConfig.optional(),
  adaptiveLimiter: adaptiveLimiterConfig.optional(),
  dedup: Schema.union([Schema.literal(false), object]).optional(),
  batch: batchConfig.optional(),
  cache: cacheConfig.optional(),
  priority: priorityConfig.optional(),
  retry: retryConfig.optional(),
  prewarm: prewarmConfig.optional(),
  onEvent: fn.optional(),
  preset: Schema.enum(["minimal", "balanced", "default", "production"] as const).optional(),
  compression: compressionConfig.optional(),
  middleware: Schema.array(fn).optional(),
  policyPresets: policyPresetsConfig.optional(),
}, { unknownKeys: "passthrough" });

export function validateMakeHttpConfig(config: MakeHttpConfig): void {
  parseConfig("MakeHttpConfig", wireConfig, config);
}

export function validateLifecycleClientConfig(config: LifecycleClientConfig): void {
  parseConfig("LifecycleClientConfig", lifecycleConfig, config);
}

export function validateDefaultHttpClientConfig(config: DefaultHttpClientConfig): void {
  parseConfig("DefaultHttpClientConfig", defaultClientConfig, config);
}
