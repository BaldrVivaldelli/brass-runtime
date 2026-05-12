import type { Schedule } from "../core/runtime/schedule";
import { asyncFlatMap, asyncSync, type Async } from "../core/types/asyncEffect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "./client";

export type HttpRetryScheduleInput = {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly request: HttpRequest;
  readonly error?: HttpError;
  readonly status?: number;
  readonly retryAfterMs?: number;
};

export type HttpRequestRetryOverride =
  | false
  | {
      readonly maxRetries?: number;
      readonly baseDelayMs?: number;
      readonly maxDelayMs?: number;
      readonly schedule?: Schedule<HttpRetryScheduleInput, unknown>;
      readonly retryOnStatus?: (status: number) => boolean;
    };

export type HttpRequestPolicy = {
  readonly preset?: string;
  readonly lane?: string;
  readonly dedupKey?: string;
  readonly priority?: number;
  readonly retry?: HttpRequestRetryOverride;
  readonly poolKey?: string;
};

export type HttpRequestPolicyRef = HttpRequestPolicy | string;

export type HttpPolicyPreset =
  | HttpRequestPolicy
  | ((request: HttpRequest, presetName: string) => HttpRequestPolicy);

export type HttpPolicyPresets = Record<string, HttpPolicyPreset>;

type LegacyHttpPolicyFields = {
  readonly lane?: string;
  readonly dedupKey?: string;
  readonly priority?: number;
  readonly retry?: HttpRequestRetryOverride;
};

export type ResolveHttpRequestPolicyOptions = {
  readonly presets?: HttpPolicyPresets;
};

const hasOwn = (value: object, key: keyof HttpRequestPolicy) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPolicyObject = (value: unknown): value is HttpRequestPolicy =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const defineHttpPolicyPresets = <Presets extends HttpPolicyPresets>(
  presets: Presets,
): Presets => presets;

export const httpPolicy = Object.freeze({
  preset: (preset: string, overrides: Omit<HttpRequestPolicy, "preset"> = {}): HttpRequestPolicy => ({
    preset,
    ...overrides,
  }),
  lane: (lane: string, overrides: Omit<HttpRequestPolicy, "preset" | "lane"> = {}): HttpRequestPolicy => ({
    preset: lane,
    lane,
    ...overrides,
  }),
  define: defineHttpPolicyPresets,
});

export const getHttpRequestPolicy = (
  req: HttpRequest,
  options: ResolveHttpRequestPolicyOptions = {},
): HttpRequestPolicy => {
  const legacy = req as HttpRequest & LegacyHttpPolicyFields;
  const source = req.policy;
  const sourcePolicy = resolvePolicySource(req, source, options.presets);
  const policy: HttpRequestPolicy = {
    ...(legacy.lane !== undefined ? { lane: legacy.lane } : {}),
    ...(legacy.dedupKey !== undefined ? { dedupKey: legacy.dedupKey } : {}),
    ...(legacy.priority !== undefined ? { priority: legacy.priority } : {}),
    ...(legacy.retry !== undefined ? { retry: legacy.retry } : {}),
    ...(req.poolKey !== undefined ? { poolKey: req.poolKey } : {}),
    ...sourcePolicy,
  };

  return policy;
};

export const withHttpRequestPolicy = (
  req: HttpRequest,
  patch: Partial<HttpRequestPolicy>,
): HttpRequest => {
  const current = getHttpRequestPolicy(req);
  const next = {
    ...req,
    policy: {
      ...current,
      ...patch,
    },
  } as HttpRequest & Partial<LegacyHttpPolicyFields>;

  if (hasOwn(patch, "poolKey")) {
    next.poolKey = patch.poolKey;
  }
  if (hasOwn(patch, "lane")) {
    next.lane = patch.lane;
  }
  if (hasOwn(patch, "dedupKey")) {
    next.dedupKey = patch.dedupKey;
  }
  if (hasOwn(patch, "priority")) {
    next.priority = patch.priority;
  }
  if (hasOwn(patch, "retry")) {
    next.retry = patch.retry;
  }

  return next;
};

export const resolveHttpRequestPolicyPresets = (
  req: HttpRequest,
  presets: HttpPolicyPresets,
): HttpRequest => {
  const policy = getHttpRequestPolicy(req, { presets });
  return withHttpRequestPolicy({ ...req, policy }, policy);
};

export const withHttpPolicyPresets = (
  presets: HttpPolicyPresets,
): HttpMiddleware => {
  return (next) => (req) =>
    asyncFlatMap(
      asyncSync(() => resolveHttpRequestPolicyPresets(req, presets)) as Async<unknown, never, HttpRequest>,
      (resolved) => next(resolved),
    );
};

function resolvePolicySource(
  req: HttpRequest,
  source: HttpRequest["policy"],
  presets: HttpPolicyPresets | undefined,
): HttpRequestPolicy {
  if (typeof source === "string") {
    return resolveNamedPolicy(req, source, {}, presets);
  }

  if (!isPolicyObject(source)) return {};

  if (!source.preset) return source;

  return resolveNamedPolicy(req, source.preset, source, presets);
}

function resolveNamedPolicy(
  req: HttpRequest,
  presetName: string,
  overrides: HttpRequestPolicy,
  presets: HttpPolicyPresets | undefined,
): HttpRequestPolicy {
  const named = presets?.[presetName];
  const resolved = typeof named === "function"
    ? named(req, presetName)
    : named;

  return {
    lane: presetName,
    ...(isPolicyObject(resolved) ? resolved : {}),
    ...overrides,
    preset: presetName,
  };
}
