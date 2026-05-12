import { async } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { Cause } from "../core/types/effect";
import { ZStream, streamFromReadableStream } from "../core/stream/stream";
import { Request } from "./optics/request";
import type {
  HttpError,
  HttpRequest,
  HttpWireResponse,
  HttpWireResponseStream,
} from "./client";
import {
  isExternalAbortError,
  isHttpError,
  toHttpError,
  type ToHttpErrorOptions,
} from "./errors";

export type HttpTransportContext = {
  readonly request: HttpRequest;
  readonly url: URL;
  readonly signal: AbortSignal;
};

export type HttpTransport = (
  context: HttpTransportContext,
) => Async<unknown, HttpError, HttpWireResponse>;

export type HttpStreamTransport = (
  context: HttpTransportContext,
) => Async<unknown, HttpError, HttpWireResponseStream>;

export type HttpTransportTiming = {
  readonly startedAt: number;
  readonly durationMs: number;
};

export type PromiseHttpTransportResponse = Omit<HttpWireResponse, "ms"> & {
  readonly ms?: number;
};

export type PromiseHttpTransportConfig<Response> = {
  readonly request: (context: HttpTransportContext) => Promise<Response>;
  readonly response: (
    response: Response,
    context: HttpTransportContext,
    timing: HttpTransportTiming,
  ) => PromiseHttpTransportResponse | Promise<PromiseHttpTransportResponse>;
  readonly error?: (error: unknown, context: HttpTransportContext) => HttpError;
};

export type PromiseHttpTransportResponseInfo<Meta = unknown> = {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: unknown;
  readonly ms?: number;
  readonly transportMeta?: Meta;
};

export type PromiseHttpTransportResponseInfoMapper<Response, Meta = unknown> = (
  response: Response,
  context: HttpTransportContext,
  timing: HttpTransportTiming,
) => PromiseHttpTransportResponseInfo<Meta> | Promise<PromiseHttpTransportResponseInfo<Meta>>;

export type PromiseHttpTransportBodySelector<Response, Body = unknown> = (
  response: Response,
  context: HttpTransportContext,
  timing: HttpTransportTiming,
) => Body | Promise<Body>;

export type PromiseHttpTransportRequestConfigContext = Omit<HttpTransportContext, "signal">;

export type PromiseHttpTransportRequestConfigMapper<Config> = (
  context: PromiseHttpTransportRequestConfigContext,
) => Config | Promise<Config>;

export type PromiseHttpTransportConfigWithSignal<Config> =
  Config extends object ? Config & { readonly signal: AbortSignal } : Config;

export type PromiseHttpTransportRequestConfigBuilder<Config> = {
  readonly send: <Response>(
    send: (config: PromiseHttpTransportConfigWithSignal<Config>) => Promise<Response>,
  ) => PromiseHttpTransportBodyBuilder<Response>;
};

export type PromiseHttpTransportFluentResponseBuilder<Response> = {
  readonly response: (
    response?: PromiseHttpTransportResponseInfoMapper<Response>,
  ) => HttpTransport;
  readonly error: (
    error: NonNullable<PromiseHttpTransportConfig<Response>["error"]>,
  ) => PromiseHttpTransportFluentResponseBuilder<Response>;
};

export type PromiseHttpTransportBodyBuilder<Response> = {
  readonly response: (
    response: PromiseHttpTransportConfig<Response>["response"],
  ) => HttpTransport;
  readonly json: <Body = unknown>(
    body?: PromiseHttpTransportBodySelector<Response, Body>,
    response?: PromiseHttpTransportResponseInfoMapper<Response>,
  ) => HttpTransport;
  readonly text: (
    body?: PromiseHttpTransportBodySelector<Response, unknown>,
    response?: PromiseHttpTransportResponseInfoMapper<Response>,
  ) => HttpTransport;
  readonly fromJson: <Body = unknown>(
    body?: PromiseHttpTransportBodySelector<Response, Body>,
  ) => PromiseHttpTransportFluentResponseBuilder<Response>;
  readonly fromText: (
    body?: PromiseHttpTransportBodySelector<Response, unknown>,
  ) => PromiseHttpTransportFluentResponseBuilder<Response>;
  readonly error: (
    error: NonNullable<PromiseHttpTransportConfig<Response>["error"]>,
  ) => PromiseHttpTransportBodyBuilder<Response>;
};

export type PromiseHttpTransportStartBuilder = {
  readonly request: <Response>(
    request: PromiseHttpTransportConfig<Response>["request"],
  ) => PromiseHttpTransportBodyBuilder<Response>;
  readonly requestConfig: <Config>(
    request: PromiseHttpTransportRequestConfigMapper<Config>,
  ) => PromiseHttpTransportRequestConfigBuilder<Config>;
};

export const isTaggedHttpError = (error: unknown): error is HttpError => {
  return isHttpError(error);
};

export const isAbortError = (error: unknown): boolean =>
  isExternalAbortError(error);

export const normalizeHttpError = (error: unknown, options?: ToHttpErrorOptions): HttpError =>
  toHttpError(error, options);

export const headersOf = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

export function normalizeHttpHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, item) => {
      if (!Array.isArray(item) || item.length < 2) return acc;
      const [key, value] = item;
      if (key !== undefined && value !== undefined && value !== null) {
        acc[String(key)] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
      }
      return acc;
    }, {});
  }

  if (typeof (headers as { toJSON?: unknown }).toJSON === "function") {
    return normalizeHttpHeaders((headers as { toJSON: () => unknown }).toJSON());
  }

  if (typeof headers === "object") {
    return Object.entries(headers as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value !== undefined && value !== null) {
        acc[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
      }
      return acc;
    }, {});
  }

  return {};
}

export const abortErrorForSignal = (signal: AbortSignal): HttpError => {
  const reason = signal.reason;
  if (isTaggedHttpError(reason) && reason._tag === "Timeout") return reason;
  return { _tag: "Abort" };
};

export const linkAbortSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): { signal: AbortSignal; cleanup: () => void } => {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; abort: () => void }> = [];

  const abortFrom = (signal: AbortSignal) => {
    try {
      controller.abort(signal.reason);
    } catch {
      controller.abort();
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }

    const abort = () => abortFrom(signal);
    signal.addEventListener("abort", abort, { once: true });
    listeners.push({ signal, abort });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener("abort", listener.abort);
      }
      listeners.length = 0;
    },
  };
};

const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const hasMethod = <Name extends string>(
  value: unknown,
  name: Name,
): value is Record<Name, (...args: never[]) => unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<Name, unknown>)[name] === "function";

const defaultPromiseBody = (response: unknown, mode: "json" | "text"): unknown | Promise<unknown> => {
  if (mode === "json" && hasMethod(response, "json")) return response.json();
  if (mode === "text" && hasMethod(response, "text")) return response.text();

  if (typeof response === "object" && response !== null) {
    const record = response as Record<string, unknown>;
    if ("data" in record) return record.data;
    if ("bodyText" in record) return record.bodyText;
    if ("body" in record) return record.body;
  }

  return response;
};

const encodePromiseBody = (body: unknown, mode: "json" | "text"): string => {
  if (mode === "text") return body === undefined || body === null ? "" : String(body);
  const encoded = JSON.stringify(body);
  return encoded === undefined ? "" : encoded;
};

const finiteNumber = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

const injectSignal = <Config>(
  config: Config,
  signal: AbortSignal,
): PromiseHttpTransportConfigWithSignal<Config> =>
  isPlainRecord(config)
    ? ({ ...config, signal } as PromiseHttpTransportConfigWithSignal<Config>)
    : (config as PromiseHttpTransportConfigWithSignal<Config>);

const inferPromiseResponseInfo = (response: unknown): PromiseHttpTransportResponseInfo => {
  if (typeof response !== "object" || response === null) {
    return { status: 200, statusText: "", headers: {} };
  }

  const record = response as Record<string, unknown>;
  return {
    status: finiteNumber(record.status) ?? finiteNumber(record.statusCode) ?? 200,
    statusText:
      typeof record.statusText === "string"
        ? record.statusText
        : typeof record.statusMessage === "string"
          ? record.statusMessage
          : "",
    headers: record.headers,
    ms: finiteNumber(record.ms),
  };
};

const toPromiseTransportResponse = (
  bodyText: string,
  info: PromiseHttpTransportResponseInfo,
): PromiseHttpTransportResponse => ({
  status: info.status ?? 200,
  statusText: info.statusText ?? "",
  headers: normalizeHttpHeaders(info.headers),
  bodyText,
  ...(info.ms !== undefined ? { ms: info.ms } : {}),
  ...(info.transportMeta !== undefined ? { transportMeta: info.transportMeta } : {}),
});

export function makePromiseHttpTransport<Response>(
  config: PromiseHttpTransportConfig<Response>,
): HttpTransport {
  return (context) =>
    async((_env, cb) => {
      let done = false;

      const finish = (exit: Parameters<typeof cb>[0]) => {
        if (done) return;
        done = true;
        context.signal.removeEventListener("abort", abort);
        cb(exit);
      };

      const fail = (error: HttpError) =>
        finish({ _tag: "Failure", cause: Cause.fail(error) });

      const abort = () => fail(abortErrorForSignal(context.signal));

      if (context.signal.aborted) {
        abort();
        return;
      }

      context.signal.addEventListener("abort", abort, { once: true });

      const run = async () => {
        const startedAt = nowMs();
        try {
          const raw = await config.request(context);
          const durationMs = Math.round(nowMs() - startedAt);
          const mapped = await config.response(raw, context, { startedAt, durationMs });
          finish({
            _tag: "Success",
            value: {
              ...mapped,
              ms: mapped.ms ?? durationMs,
            },
          });
        } catch (error) {
          if (context.signal.aborted) {
            fail(abortErrorForSignal(context.signal));
            return;
          }
          fail(config.error?.(error, context) ?? normalizeHttpError(error, { signal: context.signal }));
        }
      };

      void run();

      return () => {
        if (done) return;
        done = true;
        context.signal.removeEventListener("abort", abort);
      };
    });
}

function makePromiseHttpTransportBodyBuilder<Response>(
  config: Pick<PromiseHttpTransportConfig<Response>, "request" | "error">,
): PromiseHttpTransportBodyBuilder<Response> {
  const makeBodyTransport = (
    mode: "json" | "text",
    body: PromiseHttpTransportBodySelector<Response, unknown> | undefined,
    responseMapper: PromiseHttpTransportResponseInfoMapper<Response> | undefined,
    currentConfig: Pick<PromiseHttpTransportConfig<Response>, "request" | "error"> = config,
  ): HttpTransport =>
    makePromiseHttpTransport({
      ...currentConfig,
      response: async (raw, context, timing) => {
        const selected = await (body ?? ((value) => defaultPromiseBody(value, mode)))(raw, context, timing);
        const inferred = inferPromiseResponseInfo(raw);
        const mapped = responseMapper ? await responseMapper(raw, context, timing) : {};
        return toPromiseTransportResponse(encodePromiseBody(selected, mode), {
          ...inferred,
          ...mapped,
          headers: mapped.headers ?? inferred.headers,
        });
      },
    });

  const makeFluentResponseBuilder = (
    mode: "json" | "text",
    body: PromiseHttpTransportBodySelector<Response, unknown> | undefined,
    currentConfig: Pick<PromiseHttpTransportConfig<Response>, "request" | "error"> = config,
  ): PromiseHttpTransportFluentResponseBuilder<Response> => {
    return {
      response: (responseMapper) =>
        makeBodyTransport(mode, body, responseMapper, currentConfig),
      error: (error) => makeFluentResponseBuilder(mode, body, { ...currentConfig, error }),
    };
  };

  return {
    response: (response) => makePromiseHttpTransport({ ...config, response }),
    json: (body, response) => makeBodyTransport("json", body, response),
    text: (body, response) => makeBodyTransport("text", body, response),
    fromJson: (body) => makeFluentResponseBuilder("json", body),
    fromText: (body) => makeFluentResponseBuilder("text", body),
    error: (error) => makePromiseHttpTransportBodyBuilder({ ...config, error }),
  };
}

function makePromiseHttpTransportRequestConfigBuilder<Config>(
  requestConfig: PromiseHttpTransportRequestConfigMapper<Config>,
): PromiseHttpTransportRequestConfigBuilder<Config> {
  return {
    send: (send) =>
      makePromiseHttpTransportBodyBuilder({
        request: async (context) => {
          const config = await requestConfig({
            request: context.request,
            url: context.url,
          });
          return send(injectSignal(config, context.signal));
        },
      }),
  };
}

export function promiseHttpTransport(): PromiseHttpTransportStartBuilder {
  return {
    request: (request) => makePromiseHttpTransportBodyBuilder({ request }),
    requestConfig: (requestConfig) => makePromiseHttpTransportRequestConfigBuilder(requestConfig),
  };
}

const fetchUnavailableError = (): HttpError => ({
  _tag: "FetchError",
  message:
    "global `fetch` is not available; provide MakeHttpConfig.transport/streamTransport or run in an environment with fetch support.",
});

export function makeFetchTransport(): HttpTransport {
  return ({ request, url, signal }) =>
    async((_env, cb) => {
      if (typeof fetch === "undefined") {
        cb({ _tag: "Failure", cause: Cause.fail(fetchUnavailableError()) });
        return;
      }

      const localController = new AbortController();
      const linkedSignal = linkAbortSignals(signal, (request.init as { signal?: AbortSignal } | undefined)?.signal, localController.signal);
      let done = false;

      const finish = (exit: Parameters<typeof cb>[0]) => {
        if (done) return;
        done = true;
        linkedSignal.cleanup();
        cb(exit);
      };

      const run = async () => {
        try {
          if (linkedSignal.signal.aborted) throw abortErrorForSignal(linkedSignal.signal);

          const started = nowMs();
          const response = await fetch(url, {
            ...(request.init ?? {}),
            method: request.method,
            headers: Request.headers.get(request),
            body: request.body as BodyInit | undefined,
            signal: linkedSignal.signal,
          });

          const bodyText = await response.text();
          const latencyMs = Math.round(nowMs() - started);
          finish({
            _tag: "Success",
            value: {
              status: response.status,
              statusText: response.statusText,
              headers: headersOf(response),
              bodyText,
              ms: latencyMs,
            },
          });
        } catch (error) {
          finish({
            _tag: "Failure",
            cause: Cause.fail(normalizeHttpError(error, { signal: linkedSignal.signal })),
          });
        }
      };

      void run();

      return () => {
        if (done) return;
        try {
          localController.abort();
        } catch {
          // ignore
        }
      };
    });
}

export function makeFetchStreamTransport(): HttpStreamTransport {
  return ({ request, url, signal }) =>
    async((_env, cb) => {
      if (typeof fetch === "undefined") {
        cb({ _tag: "Failure", cause: Cause.fail(fetchUnavailableError()) });
        return;
      }

      const localController = new AbortController();
      const linkedSignal = linkAbortSignals(signal, (request.init as { signal?: AbortSignal } | undefined)?.signal, localController.signal);
      let done = false;
      let cleanupTransferredToBody = false;

      const cleanup = () => {
        if (!cleanupTransferredToBody) linkedSignal.cleanup();
      };

      const finish = (exit: Parameters<typeof cb>[0]) => {
        if (done) return;
        done = true;
        cleanup();
        cb(exit);
      };

      const run = async () => {
        try {
          if (linkedSignal.signal.aborted) throw abortErrorForSignal(linkedSignal.signal);

          const started = nowMs();
          const response = await fetch(url, {
            ...(request.init ?? {}),
            method: request.method,
            headers: Request.headers.get(request),
            body: request.body as BodyInit | undefined,
            signal: linkedSignal.signal,
          });

          const headers = headersOf(response);
          const latencyMs = Math.round(nowMs() - started);
          const body = streamFromReadableStream(response.body, normalizeHttpError, {
            signal: linkedSignal.signal,
            onRelease: linkedSignal.cleanup,
          });
          cleanupTransferredToBody = response.body !== null;

          finish({
            _tag: "Success",
            value: {
              status: response.status,
              statusText: response.statusText,
              headers,
              body,
              ms: latencyMs,
            },
          });
        } catch (error) {
          finish({
            _tag: "Failure",
            cause: Cause.fail(normalizeHttpError(error, { signal: linkedSignal.signal })),
          });
        }
      };

      void run();

      return () => {
        if (done) return;
        try {
          localController.abort();
        } catch {
          // ignore
        }
      };
    });
}
