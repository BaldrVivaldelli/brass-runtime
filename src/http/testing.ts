import { toPromise } from "../core/runtime/runtime";
import {
  layerValue,
  type Layer,
  type LayerContext,
  type ServiceTag,
} from "../core/runtime/layer";
import { asyncFail, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import {
  decorate,
  type HttpClient,
  type HttpClientFn,
  type HttpClientStats,
  type HttpError,
  type HttpRequest,
  type HttpWireResponse,
} from "./client";
import { makeDefaultHttpClient, type DefaultHttpClient } from "./defaultClient";
import { HttpClientService } from "./layer";

export type HttpTestResponseInit = {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly ms?: number;
};

export type MockHttpHandler = (
  req: HttpRequest,
  index: number,
) => HttpWireResponse | Async<unknown, HttpError, HttpWireResponse>;

export type MockHttpClient = HttpClient & {
  readonly calls: () => readonly HttpRequest[];
  readonly calledTimes: () => number;
  readonly lastRequest: () => HttpRequest | undefined;
  readonly reset: () => void;
};

export type MockDefaultHttpClient = DefaultHttpClient & {
  readonly calls: () => readonly HttpRequest[];
  readonly calledTimes: () => number;
  readonly lastRequest: () => HttpRequest | undefined;
  readonly reset: () => void;
};

export type MockDefaultHttpClientLayerOptions = {
  readonly tag?: ServiceTag<DefaultHttpClient>;
};

export type MockFetchCall = {
  readonly input: RequestInfo | URL;
  readonly init?: RequestInit;
};

export type MockFetchHandler = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  index: number,
) => Response | Promise<Response>;

export type MockFetchController = {
  readonly fetch: typeof fetch;
  readonly calls: () => readonly MockFetchCall[];
  readonly calledTimes: () => number;
  readonly lastCall: () => MockFetchCall | undefined;
  readonly restore: () => void;
};

type MutableMockStats = {
  inFlight: number;
  started: number;
  succeeded: number;
  failed: number;
  aborted: number;
  timedOut: number;
  poolRejected: number;
  poolTimeouts: number;
  lastDurationMs?: number;
};

export function makeHttpResponse(
  bodyText = "",
  init: HttpTestResponseInit = {},
): HttpWireResponse {
  return {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: init.headers ?? {},
    bodyText,
    ms: init.ms ?? 0,
  };
}

export function makeTextHttpResponse(
  bodyText: string,
  init: HttpTestResponseInit = {},
): HttpWireResponse {
  return makeHttpResponse(bodyText, init);
}

export function makeJsonHttpResponse(
  body: unknown,
  init: HttpTestResponseInit = {},
): HttpWireResponse {
  return makeHttpResponse(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function makeMockHttpClient(
  handler: MockHttpHandler = () => makeHttpResponse(),
): MockHttpClient {
  const calls: HttpRequest[] = [];
  const stats: MutableMockStats = {
    inFlight: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
    timedOut: 0,
    poolRejected: 0,
    poolTimeouts: 0,
  };

  const run: HttpClientFn = (req) => {
    calls.push(req);
    stats.started++;
    try {
      const result = handler(req, calls.length - 1);
      if (isAsync(result)) return result;
      stats.succeeded++;
      return asyncSucceed(result);
    } catch (error) {
      stats.failed++;
      return asyncFail(toHttpError(error));
    }
  };

  return Object.assign(decorate(run, () => ({ ...stats }) as HttpClientStats), {
    calls: () => [...calls],
    calledTimes: () => calls.length,
    lastRequest: () => calls.at(-1),
    reset: () => {
      calls.length = 0;
      stats.inFlight = 0;
      stats.started = 0;
      stats.succeeded = 0;
      stats.failed = 0;
      stats.aborted = 0;
      stats.timedOut = 0;
      stats.poolRejected = 0;
      stats.poolTimeouts = 0;
      delete stats.lastDurationMs;
    },
  });
}

export function makeSequenceHttpClient(
  responses: readonly HttpWireResponse[],
  fallback: HttpWireResponse = makeHttpResponse(),
): MockHttpClient {
  return makeMockHttpClient((_req, index) => responses[index] ?? fallback);
}

export function makeMockDefaultHttpClient(
  handler: MockHttpHandler = () => makeHttpResponse(),
): MockDefaultHttpClient {
  const wire = makeMockHttpClient(handler);
  const client = makeDefaultHttpClient({
    baseUrl: "http://brass.test",
    preset: "minimal",
    transport: ({ request }) => wire(request),
  });

  return Object.assign(client, {
    calls: wire.calls,
    calledTimes: wire.calledTimes,
    lastRequest: wire.lastRequest,
    reset: wire.reset,
  });
}

export function makeMockDefaultHttpClientLayer(
  handler: MockHttpHandler = () => makeHttpResponse(),
  options: MockDefaultHttpClientLayerOptions = {},
): Layer<LayerContext, never, LayerContext> {
  return layerValue(options.tag ?? HttpClientService, makeMockDefaultHttpClient(handler));
}

export function runHttpEffect<E, A>(effect: Async<unknown, E, A>, env: unknown = {}): Promise<A> {
  return toPromise(effect, env);
}

export function makeFetchResponse(body: BodyInit | null = null, init: ResponseInit = {}): Response {
  assertResponseAvailable();
  return new Response(body, init);
}

export function makeJsonFetchResponse(body: unknown, init: ResponseInit = {}): Response {
  assertResponseAvailable();
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function installMockFetch(handler: MockFetchHandler): MockFetchController {
  const target = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const original = target.fetch;
  const calls: MockFetchCall[] = [];

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init, calls.length - 1);
  }) as typeof fetch;

  target.fetch = mockFetch;

  return {
    fetch: mockFetch,
    calls: () => [...calls],
    calledTimes: () => calls.length,
    lastCall: () => calls.at(-1),
    restore: () => {
      if (original) target.fetch = original;
      else Reflect.deleteProperty(target, "fetch");
    },
  };
}

export async function withMockFetch<A>(
  handler: MockFetchHandler,
  run: (mock: MockFetchController) => Promise<A> | A,
): Promise<A> {
  const mock = installMockFetch(handler);
  try {
    return await run(mock);
  } finally {
    mock.restore();
  }
}

function isAsync(value: unknown): value is Async<unknown, HttpError, HttpWireResponse> {
  return typeof value === "object" && value !== null && "_tag" in value;
}

function toHttpError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  return { _tag: "FetchError", message: error instanceof Error ? error.message : String(error) };
}

function isHttpError(error: unknown): error is HttpError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  const tag = (error as any)._tag;
  return (
    tag === "Abort" ||
    tag === "BadUrl" ||
    tag === "FetchError" ||
    tag === "Timeout" ||
    tag === "PoolRejected" ||
    tag === "PoolTimeout" ||
    tag === "PoolClosed" ||
    tag === "BatchSplitError"
  );
}

function assertResponseAvailable(): void {
  if (typeof Response === "undefined") {
    throw new Error("HTTP test helpers require global Response for fetch response mocks.");
  }
}
