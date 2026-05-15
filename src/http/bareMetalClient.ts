import { Schema, parseConfig } from "../schema";
import type { HttpTransport, HttpStreamTransport } from "./transport";
import { makeFetchTransport, makeFetchStreamTransport, abortErrorForSignal, linkAbortSignals, normalizeHttpError } from "./transport";
import type { HttpPoolConfig } from "./pool";
import type { AdaptiveLimiterConfig } from "./adaptiveLimiter";
import type { Async } from "../core/types/asyncEffect";
import { asyncFail } from "../core/types/asyncEffect";
import { fromPromiseAbortable } from "../core/runtime/runtime";
import {
  decorate,
  decorateStream,
  fetchLabel,
  normalizeRequest,
  releaseFailure,
  releaseSuccess,
  requestPriority,
  resolvePositiveTimeout,
  resolveRequestUrl,
  runTransportEffect,
  timeoutReason,
  makeHttpStats,
  makePool,
  makeAdaptiveLimiter,
  runDirectTransport,
  runPoolTransport,
  type HttpClient,
  type HttpClientFn,
  type HttpClientStream,
  type HttpClientStreamFn,
  type HttpError,
  type HttpWireResponse,
  type HttpWireResponseStream,
} from "./client";
import { resolveHttpPoolKey } from "./pool";

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

/**
 * Event emitted by the bare-metal client. Intentionally minimal — only
 * construction-time warnings and lifecycle signals are emitted.
 */
export type BareMetalHttpEvent = {
  readonly type: "warning";
  readonly message: string;
};

/**
 * Configuration for the bare-metal HTTP client factories.
 *
 * Contains only wire-level options — no lifecycle/middleware config.
 * All fields are optional; sensible defaults (fetch transport, no pool,
 * no timeout) are applied when omitted.
 */
export interface BareMetalHttpConfig {
  /** Base URL prepended to relative request paths. */
  readonly baseUrl?: string;
  /** Default headers merged under per-request headers. */
  readonly headers?: Record<string, string>;
  /** Request timeout in milliseconds (≥ 1). Disabled when omitted. */
  readonly timeoutMs?: number;
  /** Effect-based transport. Defaults to fetch when omitted. */
  readonly transport?: HttpTransport;
  /** Effect-based streaming transport. Defaults to fetch streaming when omitted. */
  readonly streamTransport?: HttpStreamTransport;
  /** Connection pool config. Set `false` to explicitly disable. */
  readonly pool?: false | HttpPoolConfig;
  /** Adaptive concurrency limiter config. Set `false` to explicitly disable. */
  readonly adaptiveLimiter?: false | AdaptiveLimiterConfig;
  /** Optional event callback for construction-time warnings. */
  readonly onEvent?: (event: BareMetalHttpEvent) => void;
}

// ---------------------------------------------------------------------------
// Config validation schema
// ---------------------------------------------------------------------------

const fn = Schema.custom<Function>(
  (value): value is Function => typeof value === "function",
  "function",
);

const poolConfig = Schema.union([
  Schema.literal(false),
  Schema.object(
    {
      concurrency: Schema.number({ min: 1, int: true }).optional(),
      maxQueue: Schema.number({ min: 0, int: true }).optional(),
      queueTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
      key: Schema.union([
        Schema.enum(["global", "origin", "host"] as const),
        fn,
      ]).optional(),
      engine: Schema.enum(["ts", "wasm"] as const).optional(),
      wasm: Schema.boolean().optional(),
    },
    { unknownKeys: "passthrough" },
  ),
]);

const adaptiveLimiterConfig = Schema.union([
  Schema.literal(false),
  Schema.object(
    {
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
      headroomStrategy: Schema.union([
        Schema.number({ min: 1 }),
        Schema.enum(["fixed", "proportional"] as const),
        fn,
        Schema.object({ type: Schema.literal("fixed"), value: Schema.number({ min: 1 }).optional() }, { unknownKeys: "passthrough" }),
        Schema.object({
          type: Schema.literal("proportional"),
          ratio: Schema.number({ min: 0 }).refine((n) => n > 0, "ratio must be > 0").optional(),
          min: Schema.number({ min: 1 }).optional(),
          max: Schema.number({ min: 1 }).optional(),
        }, { unknownKeys: "passthrough" }),
      ]).optional(),
      slowStartRecovery: Schema.boolean().optional(),
      slowStartSaturationThreshold: Schema.number({ min: 0, max: 1 }).refine((n) => n > 0, "slowStartSaturationThreshold must be in (0, 1]").optional(),
      slowStartSaturationSamples: Schema.number({ min: 1, int: true }).optional(),
      key: Schema.union([Schema.enum(["global", "origin", "host"] as const), fn]).optional(),
      maxQueue: Schema.number({ min: 0, int: true }).optional(),
      queueTimeoutMs: Schema.number({ min: 1, int: true }).optional(),
      onLimitChange: fn.optional(),
      percentile: Schema.enum(["p50", "p99"] as const).optional(),
    },
    { unknownKeys: "passthrough" },
  ),
]);

const bareMetalConfigSchema = Schema.object(
  {
    baseUrl: Schema.string().optional(),
    headers: Schema.record(Schema.string()).optional(),
    timeoutMs: Schema.number({ min: 1, int: true }).optional(),
    transport: fn.optional(),
    streamTransport: fn.optional(),
    pool: poolConfig.optional(),
    adaptiveLimiter: adaptiveLimiterConfig.optional(),
    onEvent: fn.optional(),
  },
  { unknownKeys: "passthrough" },
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a `BareMetalHttpConfig` object at construction time.
 * Throws `ConfigValidationError` with field-path issues on invalid input.
 */
export function validateBareMetalConfig(config: BareMetalHttpConfig): void {
  parseConfig("BareMetalHttpConfig", bareMetalConfigSchema, config);
}

// ---------------------------------------------------------------------------
// Transport destroy helper (mirrors client.ts internal)
// ---------------------------------------------------------------------------

const transportDestroy = (transport: HttpTransport | HttpStreamTransport): (() => void) | undefined => {
  const destroy = (transport as { destroy?: unknown }).destroy;
  return typeof destroy === "function" ? () => destroy.call(transport) : undefined;
};

// ---------------------------------------------------------------------------
// Factory: makeBareMetalHttp
// ---------------------------------------------------------------------------

/**
 * Creates a bare-metal HTTP client with zero middleware overhead.
 *
 * The returned client delegates directly to `runDirectTransport` or
 * `runPoolTransport` — no lifecycle stack (retry, dedup, cache, batch,
 * priority scheduling), no compression, no prewarm.
 *
 * Typed errors, cancellation, pool/adaptive-limiter, and stats are preserved.
 */
export function makeBareMetalHttp(cfg: BareMetalHttpConfig = {}): HttpClient {
  validateBareMetalConfig(cfg);

  const baseUrl = cfg.baseUrl ?? "";
  const defaultHeaders = cfg.headers ?? {};
  const normalize = normalizeRequest(defaultHeaders);
  const adaptiveLimiter = makeAdaptiveLimiter(cfg);
  const pool = adaptiveLimiter ? undefined : makePool(cfg);
  const metrics = makeHttpStats(pool, adaptiveLimiter);
  const transport = cfg.transport ?? makeFetchTransport();
  const destroyTransport = transportDestroy(transport);

  const run: HttpClientFn = (req0) => {
    const req = normalize(req0);
    const url = resolveRequestUrl(req, baseUrl);
    if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponse>;

    const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

    if (!adaptiveLimiter && !pool && timeoutMs === undefined) {
      return runDirectTransport(req, url, transport, metrics);
    }

    return runPoolTransport(req, url, transport, metrics, pool, adaptiveLimiter, undefined, timeoutMs);
  };

  const metadata: Pick<HttpClient, "adaptiveLimiter" | "destroy" | "shutdown"> = {};
  if (adaptiveLimiter) metadata.adaptiveLimiter = adaptiveLimiter;
  if (adaptiveLimiter || destroyTransport) {
    metadata.destroy = () => {
      adaptiveLimiter?.destroy();
      destroyTransport?.();
    };
    metadata.shutdown = () => {
      adaptiveLimiter?.shutdown();
      destroyTransport?.();
    };
  }

  return decorate(run, metrics.snapshot, metadata);
}

// ---------------------------------------------------------------------------
// Factory: makeBareMetalHttpStream
// ---------------------------------------------------------------------------

/**
 * Creates a bare-metal streaming HTTP client with zero middleware overhead.
 *
 * Mirrors `makeBareMetalHttp` but uses `streamTransport` and returns an
 * `HttpClientStream` conforming to `HttpClientStreamFn`.
 *
 * Pool leases are acquired before the stream transport and released upon
 * receiving response headers — body stream consumption is independent of
 * pool capacity.
 *
 * No lifecycle stack (retry, dedup, cache, batch, priority scheduling),
 * no compression, no prewarm.
 */
export function makeBareMetalHttpStream(cfg: BareMetalHttpConfig = {}): HttpClientStream {
  validateBareMetalConfig(cfg);

  const baseUrl = cfg.baseUrl ?? "";
  const defaultHeaders = cfg.headers ?? {};
  const normalize = normalizeRequest(defaultHeaders);
  const adaptiveLimiter = makeAdaptiveLimiter(cfg);
  const pool = adaptiveLimiter ? undefined : makePool(cfg);
  const metrics = makeHttpStats(pool, adaptiveLimiter);
  const transport = cfg.streamTransport ?? makeFetchStreamTransport();

  const run: HttpClientStreamFn = (req0) => {
    const req = normalize(req0);
    const url = resolveRequestUrl(req, baseUrl);
    if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponseStream>;

    const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

    return fromPromiseAbortable<HttpError, HttpWireResponseStream>(
      async (signal, env) => {
        let lease: { release: (...args: any[]) => void } | undefined;
        const linkedSignal = linkAbortSignals(signal, (req.init as { signal?: AbortSignal } | undefined)?.signal);
        try {
          if (linkedSignal.signal.aborted) throw abortErrorForSignal(linkedSignal.signal);

          if (adaptiveLimiter) {
            const key = resolveHttpPoolKey(adaptiveLimiter.keyResolver, req, url);
            lease = await adaptiveLimiter.acquire(key, linkedSignal.signal, { priority: requestPriority(req) });
          } else if (pool) {
            const key = resolveHttpPoolKey(pool.keyResolver, req, url);
            lease = await pool.acquire(key, linkedSignal.signal);
          }

          const response = await runTransportEffect(
            transport({ request: req, url, signal: linkedSignal.signal }),
            env,
            linkedSignal.signal,
          );

          // Release lease on headers received — body stream consumption is
          // independent of pool capacity.
          releaseSuccess(lease, adaptiveLimiter, response);
          lease = undefined;

          return response;
        } finally {
          linkedSignal.cleanup();
          if (lease) {
            releaseFailure(lease, adaptiveLimiter);
          }
        }
      },
      normalizeHttpError,
      {
        label: fetchLabel(req, url),
        timeoutMs,
        timeoutReason: timeoutMs ? () => timeoutReason(req, url, timeoutMs) : undefined,
        onStart: metrics.onStart,
        onFinish: metrics.onFinish,
      },
    );
  };

  return decorateStream(run, metrics.snapshot);
}
