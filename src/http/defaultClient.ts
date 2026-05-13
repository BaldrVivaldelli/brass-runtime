import {
  type HttpError,
  type HttpMethod,
  type HttpMiddleware,
  type HttpRequest,
  type HttpWireResponse,
} from "./client";
import { Cause, type Exit } from "../core/types/effect";
import {
  type LifecycleClient,
  type LifecycleClientConfig,
  type LifecycleStats,
} from "./lifecycle/types";
import { makeLifecycleClient } from "./lifecycle/lifecycleClient";
import {
  makeCompressionMiddleware,
  type CompressionConfig,
  type CompressionStats,
} from "./compression";
import { setHeaderIfMissing } from "./optics/request";
import type { HttpResponse } from "./httpClient";
import { toPromise as runToPromise } from "../core/runtime/runtime";
import {
  type Async,
  type AsyncWithPromise,
  asyncFail,
  asyncFlatMap,
  asyncSucceed,
  mapTryAsync,
  withAsyncPromise,
} from "../core/types/asyncEffect";
import {
  decodeJsonBody,
  encodeJsonBodyEffect,
  makeJsonParseValidationError,
  type AnyJsonSchemaLike,
  type InferJsonSchema,
  type ValidationError,
} from "./validation";
import { validateDefaultHttpClientConfig } from "./configValidation";
import { makeAdaptiveLimiterConfig, type AdaptiveLimiterConfig } from "./adaptiveLimiter";
import { buildHttpRequest as buildReq, type HttpRequestPolicyInit } from "./requestBuilder";
import { withHttpPolicyPresets, type HttpPolicyPresets } from "./requestPolicy";

type InitNoMethodBody = Omit<RequestInit, "method" | "body"> & {
  timeoutMs?: number;
  poolKey?: string;
  headers?: unknown;
} & HttpRequestPolicyInit;

type InitWithHeaders = {
  headers?: unknown;
  timeoutMs?: number;
  poolKey?: string;
} & HttpRequestPolicyInit & Record<string, unknown>;

export type HttpJsonInit<Validator extends AnyJsonSchemaLike> = InitNoMethodBody & {
  readonly schema: Validator;
  readonly schemaName?: string;
};

export type HttpPostJsonInit<Validator extends AnyJsonSchemaLike> = InitWithHeaders & {
  readonly schema: Validator;
  readonly schemaName?: string;
  readonly bodySchema?: undefined;
  readonly bodySchemaName?: string;
};

export type HttpPostJsonSchemaBodyInit<
  Validator extends AnyJsonSchemaLike,
  BodyValidator extends AnyJsonSchemaLike,
> = InitWithHeaders & {
  readonly schema: Validator;
  readonly schemaName?: string;
  readonly bodySchema: BodyValidator;
  readonly bodySchemaName?: string;
};

export type HttpPostJsonBodyInit<BodyValidator extends AnyJsonSchemaLike> = InitWithHeaders & {
  readonly schema?: undefined;
  readonly schemaName?: string;
  readonly bodySchema: BodyValidator;
  readonly bodySchemaName?: string;
};

type JsonInitNoSchema = InitNoMethodBody & {
  readonly schema?: undefined;
  readonly schemaName?: string;
};

type PostJsonInitNoSchema = InitWithHeaders & {
  readonly schema?: undefined;
  readonly schemaName?: string;
  readonly bodySchema?: undefined;
  readonly bodySchemaName?: string;
};

type AnyJsonInit = InitNoMethodBody & {
  readonly schema?: AnyJsonSchemaLike;
  readonly schemaName?: string;
};

type AnyPostJsonInit = InitWithHeaders & {
  readonly schema?: AnyJsonSchemaLike;
  readonly schemaName?: string;
  readonly bodySchema?: AnyJsonSchemaLike;
  readonly bodySchemaName?: string;
};

export type DefaultGetJson = {
  <Validator extends AnyJsonSchemaLike>(
    url: string,
    init: HttpJsonInit<Validator>,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
  <A = unknown>(
    url: string,
    init?: JsonInitNoSchema,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
};

export type DefaultPostJson = {
  <Validator extends AnyJsonSchemaLike, BodyValidator extends AnyJsonSchemaLike>(
    url: string,
    bodyObj: InferJsonSchema<BodyValidator>,
    init: HttpPostJsonSchemaBodyInit<Validator, BodyValidator>,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
  <BodyValidator extends AnyJsonSchemaLike, A = unknown>(
    url: string,
    bodyObj: InferJsonSchema<BodyValidator>,
    init: HttpPostJsonBodyInit<BodyValidator>,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
  <Validator extends AnyJsonSchemaLike>(
    url: string,
    bodyObj: unknown,
    init: HttpPostJsonInit<Validator>,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
  <A = unknown>(
    url: string,
    bodyObj: unknown,
    init?: PostJsonInitNoSchema,
  ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
};

export type DefaultHttpClientPreset =
  | "minimal"
  | "proxy"
  | "highThroughputProxy"
  | "balanced"
  | "default"
  | "production";

export type DefaultHttpClientFeatures = {
  readonly dedup: boolean;
  readonly batch: boolean;
  readonly cache: boolean;
  readonly priority: boolean;
  readonly retry: boolean;
  readonly prewarm: boolean;
  readonly adaptiveLimiter: boolean;
  readonly compression: boolean;
  readonly middleware: number;
};

export type DefaultHttpClientConfig = LifecycleClientConfig & {
  /**
   * Preset used as the baseline before caller overrides are applied.
   * - minimal: wire client + timeout only.
   * - proxy: low-latency proxy/BFF path; wire client only, no lifecycle queue or Brass timeout by default.
   * - highThroughputProxy: explicit alias for the hot proxy path; pair with makeNodeHttpProxyClient on Node.
   * - balanced: retry, priority, dedup, adaptive limiter, response compression.
   * - default: balanced + short safe-method response cache.
   * - production: stable alias for the full production-ready default preset.
   */
  readonly preset?: DefaultHttpClientPreset;
  /** Response decompression. Enabled by balanced/default presets; set false to disable. */
  readonly compression?: CompressionConfig | false;
  /** Extra middleware applied outermost after the preset stack, e.g. withHttpObservability(obs). */
  readonly middleware?: readonly HttpMiddleware[];
  /**
   * Named per-request policy presets. Requests can use `policy: "readModel"` or
   * `policy: { preset: "readModel", ...overrides }`.
   */
  readonly policyPresets?: HttpPolicyPresets;
};

export type DefaultHttpClient = {
  readonly request: (req: HttpRequest) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;
  readonly get: (url: string, init?: InitNoMethodBody) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;
  readonly post: (
    url: string,
    body?: string,
    init?: InitWithHeaders,
  ) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;
  readonly getText: (
    url: string,
    init?: InitNoMethodBody,
  ) => AsyncWithPromise<unknown, HttpError, HttpResponse<string>>;
  readonly getJson: DefaultGetJson;
  readonly postJson: DefaultPostJson;
  readonly with: (mw: HttpMiddleware) => DefaultHttpClient;
  readonly wire: LifecycleClient;
  readonly stats: () => LifecycleStats;
  readonly cache: LifecycleClient["cache"];
  readonly cancelAll: LifecycleClient["cancelAll"];
  readonly shutdown: LifecycleClient["shutdown"];
  readonly preset: DefaultHttpClientPreset;
  readonly features: DefaultHttpClientFeatures;
  readonly compression?: {
    readonly stats: () => CompressionStats;
  };
};

const MINIMAL_PRESET_CONFIG: LifecycleClientConfig = {
  timeoutMs: 30_000,
};

const PROXY_PRESET_CONFIG: LifecycleClientConfig = {};

const BALANCED_PRESET_CONFIG: LifecycleClientConfig = {
  ...MINIMAL_PRESET_CONFIG,
  dedup: {},
  priority: {
    concurrency: 32,
    queueTimeoutMs: 30_000,
  },
  retry: {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    maxElapsedMs: 5_000,
    respectRetryAfter: true,
  },
  adaptiveLimiter: makeAdaptiveLimiterConfig("balanced"),
};

const DEFAULT_CACHEABLE_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);

const DEFAULT_PRESET_CONFIG: LifecycleClientConfig = {
  ...BALANCED_PRESET_CONFIG,
  cache: {
    ttlSeconds: 60,
    maxEntries: 1_024,
    staleWhileRevalidate: true,
    cachePolicy: (req, res) => ({ cacheable: isDefaultCacheableResponse(req, res) }),
  },
  priority: {
    concurrency: 64,
    queueTimeoutMs: 30_000,
  },
  retry: {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
    maxElapsedMs: 10_000,
    respectRetryAfter: true,
  },
  adaptiveLimiter: makeAdaptiveLimiterConfig("aggressive"),
};

const PRESET_CONFIGS: Record<DefaultHttpClientPreset, LifecycleClientConfig> = {
  minimal: MINIMAL_PRESET_CONFIG,
  proxy: PROXY_PRESET_CONFIG,
  highThroughputProxy: PROXY_PRESET_CONFIG,
  balanced: BALANCED_PRESET_CONFIG,
  default: DEFAULT_PRESET_CONFIG,
  production: DEFAULT_PRESET_CONFIG,
};

function isDefaultCacheableResponse(req: HttpRequest, res: HttpWireResponse): boolean {
  if (!DEFAULT_CACHEABLE_METHODS.has(req.method)) return false;
  if (res.status < 200 || res.status >= 400) return false;

  const cacheControl = headerValue(res.headers, "cache-control")?.toLowerCase();
  if (cacheControl) {
    const directives = cacheControl.split(",").map((part) => part.trim());
    if (directives.includes("no-store") || directives.includes("no-cache")) return false;
  }

  if (headerValue(res.headers, "pragma")?.toLowerCase() === "no-cache") return false;
  if (headerValue(res.headers, "set-cookie") !== undefined) return false;
  return true;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

export const defaultHttpClientPreset: DefaultHttpClientPreset = "default";

/**
 * Creates the recommended default HTTP client.
 *
 * The returned client has the easy JSON/text helpers from `httpClient`, but its
 * wire path is the full lifecycle stack: priority, retry, cache, batch, dedup,
 * adaptive concurrency, optional prewarm, compression, stats, and cancelAll.
 */
export function makeDefaultHttpClient(
  config: DefaultHttpClientConfig = {},
): DefaultHttpClient {
  validateDefaultHttpClientConfig(config);

  const {
    preset = defaultHttpClientPreset,
    compression,
    middleware = [],
    policyPresets,
    ...lifecycleOverrides
  } = config;

  const lifecycleConfig = mergeLifecycleConfig(PRESET_CONFIGS[preset], lifecycleOverrides);
  let wire = makeLifecycleClient(lifecycleConfig);

  const compressionResult =
    compression === false || (compression === undefined && isLeanPreset(preset))
      ? undefined
      : makeCompressionMiddleware(compression === undefined ? undefined : compression);

  if (compressionResult) {
    wire = wire.with(compressionResult.middleware);
  }

  for (const mw of middleware) {
    wire = wire.with(mw);
  }

  if (policyPresets && Object.keys(policyPresets).length > 0) {
    wire = wire.with(withHttpPolicyPresets(policyPresets));
  }

  const features = featureSnapshot(lifecycleConfig, compressionResult !== undefined, middleware.length);
  const hasMiddleware = compressionResult !== undefined ||
    middleware.length > 0 ||
    (policyPresets !== undefined && Object.keys(policyPresets).length > 0);
  const transport = lifecycleConfig.transport;
  const useInlineDecode = !hasMiddleware && transport !== undefined;
  return buildDefaultClient(wire, {
    preset,
    features,
    compressionStats: compressionResult?.stats,
    useInlineDecode,
  });
}

function buildDefaultClient(
  wire: LifecycleClient,
  meta: {
    readonly preset: DefaultHttpClientPreset;
    readonly features: DefaultHttpClientFeatures;
    readonly compressionStats?: () => CompressionStats;
    readonly useInlineDecode?: boolean;
  },
): DefaultHttpClient {
  const withPromise = <E, A>(eff: Async<unknown, E, A>): AsyncWithPromise<unknown, E, A> =>
    withAsyncPromise<unknown, E, A>((e, env) => runToPromise(e, env))(eff as any);

  const requestRaw = (req: HttpRequest) => wire(req);
  const request = (req: HttpRequest) => withPromise(requestRaw(req));

  const get = (url: string, init?: InitNoMethodBody) => request(buildReq("GET", url, init as InitWithHeaders));
  const post = (url: string, body?: string, init?: InitWithHeaders) =>
    request(buildReq("POST", url, init, body));

  const getText = (url: string, init?: InitNoMethodBody) => {
    const req = buildReq("GET", url, init as InitWithHeaders);
    return withPromise(
      mapTryAsync(requestRaw(req), (w) => toResponse(w, w.bodyText)),
    );
  };

  const getJson: DefaultGetJson = ((url: string, init?: AnyJsonInit) => {
    const req = setHeaderIfMissing("accept", "application/json")(
      buildReq("GET", url, init as InitWithHeaders),
    );
    if (meta.useInlineDecode) {
      // Fused path: inline JSON decode directly in the wire callback,
      // avoiding the FlatMap continuation and NativeTopLevelRunner overhead.
      return withPromise(
        fusedWireAndDecode(requestRaw(req), init?.schema, init?.schemaName),
      );
    }
    return withPromise(
      asyncFlatMap(requestRaw(req), (w) => decodeResponse(w, init?.schema, init?.schemaName)),
    );
  }) as DefaultGetJson;

  const postJson: DefaultPostJson = ((url: string, bodyObj: unknown, init?: AnyPostJsonInit) => {
    return withPromise(
      asyncFlatMap(
        encodeJsonBodyEffect(bodyObj, init?.bodySchema, { schemaName: init?.bodySchemaName }),
        (bodyText) => {
          const req = setHeaderIfMissing("content-type", "application/json")(
            setHeaderIfMissing("accept", "application/json")(
              buildReq("POST", url, init, bodyText),
            ),
          );
          return asyncFlatMap(requestRaw(req), (w) => decodeResponse(w, init?.schema, init?.schemaName));
        },
      ),
    );
  }) as DefaultPostJson;

  return {
    request,
    get,
    post,
    getText,
    getJson,
    postJson,
    with: (mw) =>
      buildDefaultClient(wire.with(mw), {
        ...meta,
        useInlineDecode: false,
        features: {
          ...meta.features,
          middleware: meta.features.middleware + 1,
        },
      }),
    wire,
    stats: () => wire.stats(),
    cache: wire.cache,
    cancelAll: wire.cancelAll,
    shutdown: wire.shutdown,
    preset: meta.preset,
    features: meta.features,
    ...(meta.compressionStats
      ? {
          compression: {
            stats: meta.compressionStats,
          },
        }
      : {}),
  };
}

function toResponse<A>(wire: HttpWireResponse, body: A): HttpResponse<A> {
  return {
    status: wire.status,
    statusText: wire.statusText,
    headers: wire.headers,
    body,
  };
}

/**
 * Fused wire + JSON decode path for `getJson`.
 *
 * Creates a single `Async` effect that registers the wire effect and decodes
 * JSON directly in the success callback, avoiding the `asyncFlatMap` FlatMap
 * continuation and the NativeTopLevelRunner overhead of processing it.
 *
 * This is only used when the transport is a promise transport and no middleware
 * is configured on the default client.
 */
function fusedWireAndDecode<A>(
  wireEffect: Async<unknown, HttpError, HttpWireResponse>,
  schema?: AnyJsonSchemaLike,
  schemaName?: string,
): Async<unknown, HttpError | ValidationError, HttpResponse<A>> {
  return {
    _tag: "Async",
    register: (env: unknown, cb: (exit: Exit<HttpError | ValidationError, HttpResponse<A>>) => void) => {
      const innerEffect = wireEffect as { _tag: string; register?: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => void | (() => void) };

      if (innerEffect._tag === "Async" && innerEffect.register) {
        // Direct registration — fuse wire + decode into a single callback
        return innerEffect.register(env, (exit) => {
          if (exit._tag !== "Success") {
            cb(exit as Exit<HttpError | ValidationError, HttpResponse<A>>);
            return;
          }
          const wire = exit.value;
          inlineDecodeJson(wire, schema, schemaName, cb);
        });
      }

      // Fallback: if the wire effect is not a simple Async (e.g. it's a FlatMap
      // from lifecycle layers), fall back to the standard decode path.
      // This shouldn't happen when useInlineDecode is true, but is a safety net.
      const decoded = asyncFlatMap(wireEffect, (w: HttpWireResponse) => decodeResponse<A>(w, schema, schemaName));
      if (decoded._tag === "Async" && decoded.register) {
        return decoded.register(env, cb);
      }
      // Should not reach here
      cb({ _tag: "Failure", cause: Cause.fail({ _tag: "ValidationError", message: "Internal: unexpected effect shape", body: "", issues: [], phase: "response" } as ValidationError) });
    },
  };
}

/**
 * Inline JSON decode helper used by the fused path.
 * Parses bodyText as JSON, validates against schema if provided,
 * and invokes the callback with the appropriate exit.
 */
function inlineDecodeJson<A>(
  wire: HttpWireResponse,
  schema: AnyJsonSchemaLike | undefined,
  schemaName: string | undefined,
  cb: (exit: Exit<HttpError | ValidationError, HttpResponse<A>>) => void,
): void {
  if (!schema) {
    // No schema — just parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(wire.bodyText);
    } catch (error) {
      cb({ _tag: "Failure", cause: Cause.fail(makeJsonParseValidationError(wire.bodyText, error, { schemaName })) });
      return;
    }
    cb({ _tag: "Success", value: toResponse(wire, parsed as A) });
    return;
  }

  // Schema provided — parse and validate
  const result = decodeJsonBody<A>(wire.bodyText, schema as any, { schemaName });
  if (result.success) {
    cb({ _tag: "Success", value: toResponse(wire, result.data) });
  } else {
    cb({ _tag: "Failure", cause: Cause.fail(result.error) });
  }
}

function decodeResponse<A>(
  wire: HttpWireResponse,
  schema?: AnyJsonSchemaLike,
  schemaName?: string,
): Async<unknown, ValidationError, HttpResponse<A>> {
  if (!schema) {
    try {
      return asyncSucceed(toResponse(wire, JSON.parse(wire.bodyText) as A));
    } catch (error) {
      return asyncFail(makeJsonParseValidationError(wire.bodyText, error, { schemaName }));
    }
  }

  const result = decodeJsonBody<A>(wire.bodyText, schema as any, { schemaName });
  return result.success
    ? asyncSucceed(toResponse(wire, result.data))
    : asyncFail(result.error);
}

function mergeLifecycleConfig(
  defaults: LifecycleClientConfig,
  overrides: LifecycleClientConfig,
): LifecycleClientConfig {
  return {
    ...defaults,
    ...overrides,
    headers: mergeRecord(defaults.headers, overrides.headers),
    dedup: mergeLayer(defaults.dedup, overrides.dedup),
    batch: mergeLayer(defaults.batch, overrides.batch),
    cache: mergeLayer(defaults.cache, overrides.cache),
    priority: mergeLayer(defaults.priority, overrides.priority),
    retry: mergeLayer(defaults.retry, overrides.retry),
    prewarm: mergeLayer(defaults.prewarm, overrides.prewarm),
    adaptiveLimiter: mergeAdaptiveLimiterLayer(defaults.adaptiveLimiter, overrides.adaptiveLimiter),
    pool: mergeLayer(defaults.pool, overrides.pool),
  };
}

function mergeRecord<T extends Record<string, string>>(
  defaults: T | undefined,
  overrides: T | undefined,
): T | undefined {
  if (!defaults) return overrides;
  if (!overrides) return defaults;
  return { ...defaults, ...overrides } as T;
}

function mergeLayer<T extends object>(
  defaults: T | false | undefined,
  overrides: T | false | undefined,
): T | false | undefined {
  if (overrides === undefined) return defaults;
  if (overrides === false) return false;
  if (defaults === undefined || defaults === false) return overrides;
  return { ...defaults, ...overrides };
}

function mergeAdaptiveLimiterLayer(
  defaults: AdaptiveLimiterConfig | false | undefined,
  overrides: AdaptiveLimiterConfig | false | undefined,
): AdaptiveLimiterConfig | false | undefined {
  if (overrides === undefined) return defaults;
  if (overrides === false) return false;
  if (defaults === undefined || defaults === false) return overrides;
  if (overrides.preset !== undefined) return overrides;
  return { ...defaults, ...overrides };
}

function featureSnapshot(
  config: LifecycleClientConfig,
  compression: boolean,
  middleware: number,
): DefaultHttpClientFeatures {
  return Object.freeze({
    dedup: isEnabled(config.dedup),
    batch: isEnabled(config.batch),
    cache: isEnabled(config.cache),
    priority: isEnabled(config.priority),
    retry: isEnabled(config.retry),
    prewarm: isEnabled(config.prewarm),
    adaptiveLimiter: isEnabled(config.adaptiveLimiter),
    compression,
    middleware,
  });
}

function isEnabled(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function isLeanPreset(preset: DefaultHttpClientPreset): boolean {
  return preset === "minimal" || preset === "proxy" || preset === "highThroughputProxy";
}
