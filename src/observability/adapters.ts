import type { Observability } from "./setup";
import {
  makeRequestObservabilityContext,
  type RequestObservabilityContext,
  type RequestObservabilityContextInput,
} from "./request";
import { normalizeHttpRoute, sanitizeHttpTarget } from "./cardinality";
import type { TraceContextCarrier, TraceContextHeaderValue } from "./traceContext";

export type FetchLikeRequest = {
  readonly headers?: TraceContextCarrier;
  readonly method?: string;
  readonly url?: string;
};

export type NodeLikeIncomingMessage = {
  readonly headers?: Record<string, string | readonly string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
};

export type ExpressLikeRequest = NodeLikeIncomingMessage & {
  readonly originalUrl?: string;
  readonly path?: string;
  readonly route?: {
    readonly path?: string;
  };
};

export type FastifyLikeRequest = NodeLikeIncomingMessage & {
  readonly routeOptions?: {
    readonly url?: string;
  };
  readonly routerPath?: string;
};

export function makeFetchRequestObservabilityContext(
  observability: Observability,
  request: FetchLikeRequest,
  input: RequestObservabilityContextInput = {}
): RequestObservabilityContext {
  return makeRequestObservabilityContext(observability, {
    headers: request.headers,
    method: request.method,
    target: sanitizeHttpTarget(request.url),
    route: input.route ?? normalizeHttpRoute(urlPathname(request.url)),
    ...input,
  });
}

export function makeNodeRequestObservabilityContext(
  observability: Observability,
  request: NodeLikeIncomingMessage,
  input: RequestObservabilityContextInput = {}
): RequestObservabilityContext {
  return makeRequestObservabilityContext(observability, {
    headers: request.headers as Record<string, TraceContextHeaderValue> | undefined,
    method: request.method,
    target: sanitizeHttpTarget(request.url),
    route: input.route ?? normalizeHttpRoute(request.url),
    ...input,
  });
}

export function makeExpressRequestObservabilityContext(
  observability: Observability,
  request: ExpressLikeRequest,
  input: RequestObservabilityContextInput = {}
): RequestObservabilityContext {
  return makeRequestObservabilityContext(observability, {
    headers: request.headers as Record<string, TraceContextHeaderValue> | undefined,
    method: request.method,
    target: sanitizeHttpTarget(request.originalUrl ?? request.url),
    route: input.route ?? request.route?.path ?? normalizeHttpRoute(request.path ?? request.url),
    ...input,
  });
}

export function makeFastifyRequestObservabilityContext(
  observability: Observability,
  request: FastifyLikeRequest,
  input: RequestObservabilityContextInput = {}
): RequestObservabilityContext {
  return makeRequestObservabilityContext(observability, {
    headers: request.headers as Record<string, TraceContextHeaderValue> | undefined,
    method: request.method,
    target: sanitizeHttpTarget(request.url),
    route: input.route ?? request.routeOptions?.url ?? request.routerPath ?? normalizeHttpRoute(request.url),
    ...input,
  });
}

export function withFetchRequestObservability<RequestLike extends FetchLikeRequest, A>(
  observability: Observability,
  handler: (ctx: RequestObservabilityContext, request: RequestLike) => A | Promise<A>,
  input: RequestObservabilityContextInput = {}
): (request: RequestLike) => Promise<A> {
  return async (request) => handler(makeFetchRequestObservabilityContext(observability, request, input), request);
}

export function withNodeRequestObservability<RequestLike extends NodeLikeIncomingMessage, A>(
  observability: Observability,
  handler: (ctx: RequestObservabilityContext, request: RequestLike) => A | Promise<A>,
  input: RequestObservabilityContextInput = {}
): (request: RequestLike) => Promise<A> {
  return async (request) => handler(makeNodeRequestObservabilityContext(observability, request, input), request);
}

function urlPathname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return url;
  }
}
