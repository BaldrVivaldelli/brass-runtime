import type { HttpInit, HttpMethod, HttpRequest } from "./client";
import { normalizeHeadersInit } from "./client";
import { mergeHeaders } from "./optics/request";
import type { HttpRequestPolicy, HttpRequestPolicyRef, HttpRequestRetryOverride } from "./requestPolicy";

export type HttpRequestPolicyInit = {
  readonly policy?: HttpRequestPolicyRef;
  readonly lane?: string;
  readonly dedupKey?: string;
  readonly priority?: number;
  readonly retry?: HttpRequestRetryOverride;
};

export type HttpRequestBuilderInit = {
  readonly headers?: unknown;
  readonly timeoutMs?: unknown;
  readonly poolKey?: unknown;
  readonly policy?: unknown;
  readonly lane?: unknown;
  readonly dedupKey?: unknown;
  readonly priority?: unknown;
  readonly retry?: unknown;
  readonly schema?: unknown;
  readonly schemaName?: unknown;
  readonly bodySchema?: unknown;
  readonly bodySchemaName?: unknown;
};

export type SplitHttpRequestInit = {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly poolKey?: string;
  readonly policy?: HttpRequestPolicyRef;
  readonly init: HttpInit;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function splitHttpRequestInit(init?: HttpRequestBuilderInit): SplitHttpRequestInit {
  const {
    headers,
    timeoutMs,
    poolKey,
    policy,
    lane,
    dedupKey,
    priority,
    retry,
    schema: _schema,
    schemaName: _schemaName,
    bodySchema: _bodySchema,
    bodySchemaName: _bodySchemaName,
    ...rest
  } = (init ?? {}) as HttpRequestBuilderInit & Record<string, unknown>;

  const policyFields: Partial<HttpRequestPolicy> = {
    ...(isRecord(policy) ? (policy as HttpRequestPolicy) : {}),
    ...(typeof lane === "string" ? { lane } : {}),
    ...(typeof dedupKey === "string" ? { dedupKey } : {}),
    ...(typeof priority === "number" ? { priority } : {}),
    ...(retry !== undefined ? { retry: retry as HttpRequestRetryOverride } : {}),
  };
  const policyRef: HttpRequestPolicyRef | undefined =
    typeof policy === "string"
      ? Object.keys(policyFields).length > 0
        ? { preset: policy, ...policyFields }
        : policy
      : Object.keys(policyFields).length > 0
        ? (policyFields as HttpRequestPolicy)
        : undefined;

  return {
    headers: normalizeHeadersInit(headers),
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
    poolKey: typeof poolKey === "string" ? poolKey : undefined,
    policy: policyRef,
    init: rest as HttpInit,
  };
}

export function buildHttpRequest(
  method: HttpMethod,
  url: string,
  init?: HttpRequestBuilderInit,
  body?: string,
): HttpRequest {
  const split = splitHttpRequestInit(init);
  const req: HttpRequest = {
    method,
    url,
    ...(body && body.length > 0 ? { body } : {}),
    ...(split.timeoutMs !== undefined ? { timeoutMs: split.timeoutMs } : {}),
    ...(split.poolKey !== undefined ? { poolKey: split.poolKey } : {}),
    ...(split.policy !== undefined ? { policy: split.policy } : {}),
    init: split.init,
  };

  return split.headers ? mergeHeaders(split.headers)(req) : req;
}
