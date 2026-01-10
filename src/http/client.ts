// src/http/client.ts
import {Async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync} from "../core/types/asyncEffect";
import { fromPromiseAbortable } from "../core/runtime/runtime";
import { ZStream, streamFromReadableStream } from "../core/stream/stream";

// 👇 optics
import { Request, mergeHeadersUnder } from "./optics/request";
import {RetryPolicy} from "./retry/retry";

export type HttpError =
    | { _tag: "Abort" }
    | { _tag: "BadUrl"; message: string }
    | { _tag: "FetchError"; message: string };

export type HttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";

export type HttpInit = Omit<RequestInit, "method" | "body" | "headers">;

export type HttpRequest = {
    method: HttpMethod;
    url: string; // relative o absolute
    headers?: Record<string, string>;
    body?: string;
    init?: HttpInit;
};

export type HttpWireResponse = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    ms: number;
};

export type MakeHttpConfig = {
    baseUrl?: string;
    headers?: Record<string, string>;
};

export type HttpWireResponseStream = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: ZStream<unknown, HttpError, Uint8Array>;
    ms: number;
};


export type HttpClientStream = (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponseStream>;


export type HttpClient = HttpClientFn & {
    with: (mw: HttpMiddleware) => HttpClient;
};


export const withMiddleware =
    (mw: HttpMiddleware) =>
        (c: HttpClient): HttpClient =>
            decorate(mw(c));

export const decorate = (run: HttpClientFn): HttpClient =>
    Object.assign(((req: HttpRequest) => run(req)) as HttpClientFn, {
        with: (mw: HttpMiddleware) => decorate(mw(run)),
    });

export type HttpClientFn = (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponse>;
export type HttpMiddleware = (next: HttpClientFn) => HttpClientFn;

const normalizeHttpError = (e: unknown): HttpError => {
    if (e instanceof DOMException && e.name === "AbortError") return { _tag: "Abort" };
    if (typeof e === "object" && e && "_tag" in (e as any)) return e as HttpError;
    return { _tag: "FetchError", message: String(e) };
};

export const normalizeHeadersInit = (h: any): Record<string, string> | undefined => {
    if (!h) return undefined;

    // Headers
    if (typeof Headers !== "undefined" && h instanceof Headers) {
        const out: Record<string, string> = {};
        h.forEach((v: string, k: string) => (out[k] = v));
        return out;
    }

    // [ [k,v], ... ]
    if (Array.isArray(h)) return Object.fromEntries(h);

    // Record<string,string>
    if (typeof h === "object") return { ...(h as Record<string, string>) };

    return undefined;
};

// --- NUEVO: aplica defaults + init.headers usando optics ---
const normalizeRequest =
    (defaultHeaders: Record<string, string>) =>
        (req0: HttpRequest): HttpRequest => {
            // defaults por abajo (no pisan req.headers)
            let req = Object.keys(defaultHeaders).length
                ? mergeHeadersUnder(defaultHeaders)(req0)
                : req0;

            // si alguien pasó init.headers “a lo fetch”, también lo contemplamos:
            const initHeaders = normalizeHeadersInit((req0 as any).init?.headers);
            if (initHeaders && Object.keys(initHeaders).length) {
                // init.headers por abajo de req.headers, pero puede pisar defaults
                req = mergeHeadersUnder(initHeaders)(req);
            }

            return req;
        };

export function makeHttpStream(cfg: MakeHttpConfig = {}): HttpClientStream {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);

    return (req0) =>
        fromPromiseAbortable<HttpError, HttpWireResponseStream>(
            async (signal) => {
                const req = normalize(req0);

                let url: URL;
                try {
                    url = new URL(req.url, baseUrl);
                } catch {
                    throw { _tag: "BadUrl", message: `URL inválida: ${req.url}` } satisfies HttpError;
                }

                const started = performance.now();

                const res = await fetch(url, {
                    ...(req.init ?? {}),
                    method: req.method,
                    headers: Request.headers.get(req), // 👈 optics: headers ya normalizados
                    body: req.body,
                    signal,
                });

                const headers: Record<string, string> = {};
                res.headers.forEach((v, k) => (headers[k] = v));

                const body = streamFromReadableStream(res.body, normalizeHttpError);

                return {
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                    body,
                    ms: Math.round(performance.now() - started),
                };
            },
            normalizeHttpError
        );
}

export function makeHttp(cfg: MakeHttpConfig = {}): HttpClient {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);

    const run: HttpClientFn = (req0) =>
        fromPromiseAbortable<HttpError, HttpWireResponse>(
            async (signal) => {
                const req = normalize(req0);

                let url: URL;
                try {
                    url = new URL(req.url, baseUrl);
                } catch {
                    throw { _tag: "BadUrl", message: `URL inválida: ${req.url}` } satisfies HttpError;
                }

                const started = performance.now();

                const res = await fetch(url, {
                    ...(req.init ?? {}),
                    method: req.method,
                    headers: Request.headers.get(req), // 👈 optics
                    body: req.body,
                    signal,
                });

                const bodyText = await res.text();

                const headers: Record<string, string> = {};
                res.headers.forEach((v, k) => (headers[k] = v));

                return {
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                    bodyText,
                    ms: Math.round(performance.now() - started),
                };
            },
            normalizeHttpError
        );

    return decorate(run);
}


// helpers existentes


const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const defaultRetryOnError = (e: HttpError) => e._tag === "FetchError";
const defaultRetryOnStatus = (s: number) =>
    s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
const backoffDelayMs = (attempt: number, base: number, cap: number) => {
    const exp = base * Math.pow(2, attempt);
    const lim = clamp(exp, 0, cap);
    return Math.floor(Math.random() * lim);
};
const sleepMs = (ms: number) =>
    fromPromiseAbortable<HttpError, void>(
        (signal) =>
            new Promise<void>((resolve, reject) => {
                if (signal.aborted) return reject({ _tag: "Abort" } satisfies HttpError);

                const id = setTimeout(resolve, ms);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(id);
                        reject({ _tag: "Abort" } satisfies HttpError);
                    },
                    { once: true }
                );
            }),
        (e) => (typeof e === "object" && e && "_tag" in (e as any) ? (e as HttpError) : ({ _tag: "FetchError", message: String(e) } as HttpError))
    );
const retryAfterMs = (headers: Record<string, string>) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
    if (!key) return undefined;

    const v = headers[key]?.trim();
    if (!v) return undefined;

    // segundos
    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.max(0, Math.floor(secs * 1000));

    // fecha
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());

    return undefined;
};

export const withRetryStream =
    (p: RetryPolicy) =>
        (next: HttpClientStream): HttpClientStream =>
            ((req) => {
                const loop = (attempt: number): any =>
                    asyncFold(
                        next(req),
                        (e: HttpError) => {
                            if (e._tag === "Abort" || e._tag === "BadUrl") return asyncFail(e);
                            const canRetry = attempt < p.maxRetries && (p.retryOnError ?? defaultRetryOnError)(e);
                            if (!canRetry) return asyncFail(e);
                            const d = backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs);
                            return asyncFlatMap(sleepMs(d), () => loop(attempt + 1));
                        },
                        (w) => {
                            const canRetry = attempt < p.maxRetries && (p.retryOnStatus ?? defaultRetryOnStatus)(w.status);
                            if (!canRetry) return asyncSucceed(w);
                            const ra = retryAfterMs(w.headers);
                            const d = ra ?? backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs);
                            return asyncFlatMap(sleepMs(d), () => loop(attempt + 1));
                        }
                    );

                return loop(0);
            }) as any;