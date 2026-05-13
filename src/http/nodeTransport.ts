import {
  Agent as HttpAgent,
  request as httpRequest,
  type RequestOptions,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from "node:https";
import { async, type Async } from "../core/types/asyncEffect";
import { Cause } from "../core/types/effect";
import type { HttpError, HttpWireResponse } from "./client";
import { Request as HttpRequestOptic } from "./optics/request";
import {
  abortErrorForSignal,
  normalizeHttpError,
  normalizeHttpHeaders,
  type HttpTransport,
  type HttpTransportContext,
} from "./transport";

export type NodeHttpTransportConfig = {
  readonly keepAlive?: boolean;
  readonly maxSockets?: number;
  readonly maxFreeSockets?: number;
  readonly httpAgent?: HttpAgent;
  readonly httpsAgent?: HttpsAgent;
  readonly socketTimeoutMs?: number;
};

export type NodeHttpTransport = HttpTransport & {
  readonly destroy: () => void;
};

const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const toAgentOptions = (config: NodeHttpTransportConfig): ConstructorParameters<typeof HttpAgent>[0] => ({
  keepAlive: config.keepAlive ?? true,
  ...(config.maxSockets !== undefined ? { maxSockets: config.maxSockets } : {}),
  ...(config.maxFreeSockets !== undefined ? { maxFreeSockets: config.maxFreeSockets } : {}),
});

const isError = (value: unknown): value is Error => value instanceof Error;

function unsupportedProtocol(url: URL): HttpError {
  return {
    _tag: "BadUrl",
    message: `Unsupported URL protocol for node HTTP transport: ${url.protocol}`,
  };
}

function runNodeRequest(
  context: HttpTransportContext,
  config: NodeHttpTransportConfig,
  httpAgent: HttpAgent,
  httpsAgent: HttpsAgent,
): Async<unknown, HttpError, HttpWireResponse> {
  return async((_env, cb) => {
    const { request, url, signal } = context;
    const isHttps = url.protocol === "https:";
    const isHttp = url.protocol === "http:";

    if (!isHttp && !isHttps) {
      cb({ _tag: "Failure", cause: Cause.fail(unsupportedProtocol(url)) });
      return;
    }

    if (signal.aborted) {
      cb({ _tag: "Failure", cause: Cause.fail(abortErrorForSignal(signal)) });
      return;
    }

    const started = nowMs();
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let done = false;
    let abort: () => void = () => undefined;

    const finish = (exit: Parameters<typeof cb>[0]) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      cb(exit);
    };

    const fail = (error: unknown) => {
      finish({
        _tag: "Failure",
        cause: Cause.fail(normalizeHttpError(error, { signal })),
      });
    };

    const options: RequestOptions = {
      method: request.method,
      headers: HttpRequestOptic.headers.get(request),
      agent: isHttps ? httpsAgent : httpAgent,
      signal,
    };

    const nodeRequest = (isHttps ? httpsRequest : httpRequest)(url, options, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buffer);
        byteLength += buffer.length;
      });
      response.on("end", () => {
        finish({
          _tag: "Success",
          value: {
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: normalizeHttpHeaders(response.headers),
            bodyText: Buffer.concat(chunks, byteLength).toString("utf8"),
            ms: Math.round(nowMs() - started),
          },
        });
      });
      response.on("error", fail);
    });

    abort = () => {
      nodeRequest.destroy(isError(signal.reason) ? signal.reason : undefined);
      finish({ _tag: "Failure", cause: Cause.fail(abortErrorForSignal(signal)) });
    };

    signal.addEventListener("abort", abort, { once: true });
    nodeRequest.on("error", fail);

    if (config.socketTimeoutMs !== undefined && config.socketTimeoutMs > 0) {
      nodeRequest.setTimeout(config.socketTimeoutMs, () => {
        nodeRequest.destroy(Object.assign(new Error("Node HTTP socket timed out"), {
          code: "ETIMEDOUT",
        }));
      });
    }

    if (request.body !== undefined) {
      nodeRequest.write(request.body);
    }
    nodeRequest.end();

    return () => {
      if (done) return;
      nodeRequest.destroy(Object.assign(new Error("Node HTTP transport aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }));
      finish({ _tag: "Failure", cause: Cause.fail({ _tag: "Abort" } satisfies HttpError) });
    };
  });
}

export function makeNodeHttpTransport(config: NodeHttpTransportConfig = {}): NodeHttpTransport {
  const agentOptions = toAgentOptions(config);
  const httpAgent = config.httpAgent ?? new HttpAgent(agentOptions);
  const httpsAgent = config.httpsAgent ?? new HttpsAgent(agentOptions);
  const ownsHttpAgent = config.httpAgent === undefined;
  const ownsHttpsAgent = config.httpsAgent === undefined;

  const transport: HttpTransport = (context) =>
    runNodeRequest(context, config, httpAgent, httpsAgent);

  return Object.assign(transport, {
    destroy: () => {
      if (ownsHttpAgent) httpAgent.destroy();
      if (ownsHttpsAgent) httpsAgent.destroy();
    },
  });
}
