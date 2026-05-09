import {
  makeAdaptiveLimiterConfig,
  type AdaptiveLimiterConfig,
  type AdaptiveLimiterPreset,
} from "./adaptiveLimiter";
import type { BatchConfig } from "./lifecycle/batch";
import type {
  CacheConfig,
  DedupConfig,
  LifecycleClient,
  PrewarmLifecycleConfig,
  PriorityConfig,
} from "./lifecycle/types";
import type { CompressionConfig } from "./compression";
import type { HttpMiddleware } from "./client";
import type { HttpPoolConfig } from "./pool";
import type { RetryPolicy } from "./retry/retry";
import {
  makeDefaultHttpClient,
  type DefaultHttpClient,
  type DefaultHttpClientConfig,
  type DefaultHttpClientPreset,
} from "./defaultClient";

export type HttpClientBuilder = {
  readonly config: () => DefaultHttpClientConfig;
  readonly baseUrl: (baseUrl: string) => HttpClientBuilder;
  readonly header: (name: string, value: string) => HttpClientBuilder;
  readonly headers: (headers: Record<string, string>) => HttpClientBuilder;
  readonly timeoutMs: (timeoutMs: number) => HttpClientBuilder;
  readonly timeout: (timeoutMs: number) => HttpClientBuilder;
  readonly preset: (preset: DefaultHttpClientPreset) => HttpClientBuilder;
  readonly minimal: () => HttpClientBuilder;
  readonly balanced: () => HttpClientBuilder;
  readonly defaultPreset: () => HttpClientBuilder;
  readonly dedup: (config?: DedupConfig | false) => HttpClientBuilder;
  readonly noDedup: () => HttpClientBuilder;
  readonly batch: (config: BatchConfig | false) => HttpClientBuilder;
  readonly noBatch: () => HttpClientBuilder;
  readonly cache: (config?: CacheConfig | false) => HttpClientBuilder;
  readonly noCache: () => HttpClientBuilder;
  readonly priority: (config?: PriorityConfig | false) => HttpClientBuilder;
  readonly noPriority: () => HttpClientBuilder;
  readonly retry: (config?: RetryPolicy | false) => HttpClientBuilder;
  readonly noRetry: () => HttpClientBuilder;
  readonly prewarm: (config?: PrewarmLifecycleConfig | false) => HttpClientBuilder;
  readonly noPrewarm: () => HttpClientBuilder;
  readonly adaptiveLimiter: (config?: AdaptiveLimiterConfig | false) => HttpClientBuilder;
  readonly adaptiveLimiterPreset: (
    preset: AdaptiveLimiterPreset,
    overrides?: AdaptiveLimiterConfig,
  ) => HttpClientBuilder;
  readonly conservativeLimiter: (overrides?: AdaptiveLimiterConfig) => HttpClientBuilder;
  readonly balancedLimiter: (overrides?: AdaptiveLimiterConfig) => HttpClientBuilder;
  readonly aggressiveLimiter: (overrides?: AdaptiveLimiterConfig) => HttpClientBuilder;
  readonly noAdaptiveLimiter: () => HttpClientBuilder;
  readonly pool: (config?: HttpPoolConfig | false) => HttpClientBuilder;
  readonly noPool: () => HttpClientBuilder;
  readonly compression: (config?: CompressionConfig | false) => HttpClientBuilder;
  readonly noCompression: () => HttpClientBuilder;
  readonly middleware: (mw: HttpMiddleware) => HttpClientBuilder;
  readonly use: (mw: HttpMiddleware) => HttpClientBuilder;
  readonly configure: (config: DefaultHttpClientConfig) => HttpClientBuilder;
  readonly build: () => DefaultHttpClient;
  readonly buildWire: () => LifecycleClient;
};

type MutableBuilderConfig = Omit<DefaultHttpClientConfig, "middleware"> & {
  middleware?: HttpMiddleware[];
};

const DEFAULT_BUILDER_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

const cloneConfig = (config: DefaultHttpClientConfig): MutableBuilderConfig => ({
  ...config,
  headers: config.headers ? { ...config.headers } : undefined,
  middleware: config.middleware ? [...config.middleware] : undefined,
});

const freezeConfig = (config: MutableBuilderConfig): DefaultHttpClientConfig => ({
  ...config,
  headers: config.headers ? { ...config.headers } : undefined,
  middleware: config.middleware ? [...config.middleware] : undefined,
});

const mergeConfig = (
  current: MutableBuilderConfig,
  next: DefaultHttpClientConfig,
): MutableBuilderConfig => ({
  ...current,
  ...next,
  headers: {
    ...(current.headers ?? {}),
    ...(next.headers ?? {}),
  },
  middleware: [
    ...(current.middleware ?? []),
    ...(next.middleware ?? []),
  ],
});

function makeBuilder(config: MutableBuilderConfig): HttpClientBuilder {
  const replace = (patch: DefaultHttpClientConfig): HttpClientBuilder =>
    makeBuilder({
      ...config,
      ...patch,
      headers: patch.headers ? { ...patch.headers } : config.headers,
      middleware: patch.middleware ? [...patch.middleware] : config.middleware,
    });

  const setLayer = <K extends keyof DefaultHttpClientConfig>(
    key: K,
    value: DefaultHttpClientConfig[K],
  ): HttpClientBuilder => replace({ [key]: value } as DefaultHttpClientConfig);

  const middleware = (mw: HttpMiddleware): HttpClientBuilder =>
    makeBuilder({
      ...config,
      middleware: [...(config.middleware ?? []), mw],
    });

  return Object.freeze({
    config: () => freezeConfig(config),
    baseUrl: (baseUrl) => replace({ baseUrl }),
    header: (name, value) =>
      makeBuilder({
        ...config,
        headers: {
          ...(config.headers ?? {}),
          [name]: value,
        },
      }),
    headers: (headers) =>
      makeBuilder({
        ...config,
        headers: {
          ...(config.headers ?? {}),
          ...headers,
        },
      }),
    timeoutMs: (timeoutMs) => replace({ timeoutMs }),
    timeout: (timeoutMs) => replace({ timeoutMs }),
    preset: (preset) => replace({ preset }),
    minimal: () => replace({ preset: "minimal" }),
    balanced: () => replace({ preset: "balanced" }),
    defaultPreset: () => replace({ preset: "default" }),
    dedup: (layer = {}) => setLayer("dedup", layer),
    noDedup: () => setLayer("dedup", false),
    batch: (layer) => setLayer("batch", layer),
    noBatch: () => setLayer("batch", false),
    cache: (layer = {}) => setLayer("cache", layer),
    noCache: () => setLayer("cache", false),
    priority: (layer = {}) => setLayer("priority", layer),
    noPriority: () => setLayer("priority", false),
    retry: (layer = DEFAULT_BUILDER_RETRY) => setLayer("retry", layer),
    noRetry: () => setLayer("retry", false),
    prewarm: (layer = {}) => setLayer("prewarm", layer),
    noPrewarm: () => setLayer("prewarm", false),
    adaptiveLimiter: (layer = {}) => setLayer("adaptiveLimiter", layer),
    adaptiveLimiterPreset: (preset, overrides = {}) =>
      setLayer("adaptiveLimiter", makeAdaptiveLimiterConfig(preset, overrides)),
    conservativeLimiter: (overrides = {}) =>
      setLayer("adaptiveLimiter", makeAdaptiveLimiterConfig("conservative", overrides)),
    balancedLimiter: (overrides = {}) =>
      setLayer("adaptiveLimiter", makeAdaptiveLimiterConfig("balanced", overrides)),
    aggressiveLimiter: (overrides = {}) =>
      setLayer("adaptiveLimiter", makeAdaptiveLimiterConfig("aggressive", overrides)),
    noAdaptiveLimiter: () => setLayer("adaptiveLimiter", false),
    pool: (layer = {}) => setLayer("pool", layer),
    noPool: () => setLayer("pool", false),
    compression: (layer = {}) => setLayer("compression", layer),
    noCompression: () => setLayer("compression", false),
    middleware,
    use: middleware,
    configure: (next) => makeBuilder(mergeConfig(config, next)),
    build: () => makeDefaultHttpClient(freezeConfig(config)),
    buildWire: () => makeDefaultHttpClient(freezeConfig(config)).wire,
  });
}

export function httpClientBuilder(config: DefaultHttpClientConfig = {}): HttpClientBuilder {
  return makeBuilder(cloneConfig(config));
}

export const makeHttpClientBuilder = httpClientBuilder;
export const httpBuilder = httpClientBuilder;
