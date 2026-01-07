// src/http/client.ts
import {async, Async, asyncFlatMap, asyncSucceed, asyncSync} from "../core/types/asyncEffect";
import { fromPromiseAbortable } from "../core/runtime/runtime";
import {none, Option, some} from "../core/types/option";
import {succeed, ZIO} from "../core/types/effect";
import { ZStream, streamFromReadableStream } from "../core/stream/stream";


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
    // (si querés) params extra: redirect, cache, credentials, etc
    init?: HttpInit
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

export type HttpClient = (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponse>;

export function makeHttpStream(cfg: MakeHttpConfig = {}): HttpClientStream {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};

    return (req) =>
        fromPromiseAbortable<HttpError, HttpWireResponseStream>(
            async (signal) => {
                const url = new URL(req.url, baseUrl);
                const started = performance.now();

                const res = await fetch(url, {
                    ...(req.init ?? {}),
                    method: req.method,
                    headers: { ...defaultHeaders, ...(req.headers ?? {}) },
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


const normalizeHttpError = (e: unknown): HttpError => {
    if (e instanceof DOMException && e.name === "AbortError") return { _tag: "Abort" };
    if (typeof e === "object" && e && "_tag" in (e as any)) return e as HttpError;
    return { _tag: "FetchError", message: String(e) };
};

export function makeHttp(cfg: MakeHttpConfig = {}): HttpClient {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};

    return (req) =>
        fromPromiseAbortable<HttpError, HttpWireResponse>(
            async (signal) => {
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
                    headers: { ...defaultHeaders, ...(req.headers ?? {}) },
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
}

// util mini: map y mapTry (sin depender de .map en Async)
export const mapAsync = <R, E, A, B>(fa: Async<R, E, A>, f: (a: A) => B): Async<R, E, B> =>
    asyncFlatMap(fa, (a) => asyncSucceed(f(a)));

export const mapTryAsync = <R, E, A, B>(
    fa: Async<R, E, A>,
    f: (a: A) => B
): Async<R, E, B> =>
    asyncFlatMap(fa, (a) =>
        asyncSync(() => f(a)) as any // asyncSync captura throw
    );
