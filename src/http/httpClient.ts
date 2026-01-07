// src/http/httpClient.ts

import {
    HttpClient,
    HttpClientStream,
    HttpRequest,
    HttpWireResponse,
    HttpWireResponseStream,
    MakeHttpConfig,
    makeHttp,
    makeHttpStream, HttpError, mapAsync, mapTryAsync, HttpInit,
} from "./client";

import { Async } from "../core/types/asyncEffect";
import { ZStream } from "../core/stream/stream";

/* ============================================================
 * Types (non-streaming, existentes)
 * ============================================================
 */

export type HttpResponse<A> = {
    status: number;
    headers: Record<string, string>;
    body: A;
};

export type HttpMeta = {
    statusText: string;
    ms: number;
};

export type HttpResponseWithMeta<A> = HttpResponse<A> & {
    meta: HttpMeta;
};

/* ============================================================
 * Types (streaming)
 * ============================================================
 */

export type HttpResponseStream = {
    status: number;
    headers: Record<string, string>;
    body: ZStream<unknown, HttpError, Uint8Array>;
};

/* ============================================================
 * Non-streaming client (tal como ya tenías)
 * ============================================================
 */

const toResponse = <A>(w: HttpWireResponse, body: A): HttpResponse<A> => ({
    status: w.status,
    headers: w.headers,
    body,
});

const toResponseWithMeta = <A>(w: HttpWireResponse, body: A): HttpResponseWithMeta<A> => ({
    status: w.status,
    headers: w.headers,
    body,
    meta: {
        statusText: w.statusText,
        ms: w.ms,
    },
});



export function httpClient(cfg: MakeHttpConfig = {}) {
    const wire: HttpClient = makeHttp(cfg);

    const post = (
        url: string,
        body?: string,
        init?: Omit<RequestInit, "method" | "body">
    ) =>
        request({
            method: "POST",
            url,
            body: body && body.length > 0 ? body : undefined,
            init,
        });
    const postJson = <A>(
        url: string,
        bodyObj: A,
        init?: HttpInit & { headers?: Record<string, string> }
    ) => {
        const { headers, ...rest } = init ?? {};

        return request({
            method: "POST",
            url,
            body: JSON.stringify(bodyObj),
            headers: {
                "content-type": "application/json",
                ...(headers ?? {}),
            },
            init: rest,
        });
    };
    const request = (req: HttpRequest) => wire(req);

    const getText = (url: string, init?: Omit<RequestInit, "method">) =>
        mapTryAsync(
            request({ method: "GET", url, init }),
            (w) => toResponse(w, w.bodyText)
        );

    const getJson = <A>(url: string, init?: Omit<RequestInit, "method">) =>
        mapTryAsync(
            request({ method: "GET", url, init }),
            (w) => toResponse(w, JSON.parse(w.bodyText) as A)
        );

    return {
        request,
        getText,
        getJson,
        post,
        postJson
    };
}

export function httpClientWithMeta(cfg: MakeHttpConfig = {}) {
    const wire: HttpClient = makeHttp(cfg);

    const request = (req: HttpRequest) => wire(req);

    const post = (
        url: string,
        body?: string,
        init?: HttpInit & { headers?: Record<string, string> }
    ) => {
        const { headers, ...rest } = init ?? {};
        return mapTryAsync(
            request({
                method: "POST",
                url,
                body: body && body.length > 0 ? body : undefined,
                headers,
                init: rest,
            }),
            (w) => toResponseWithMeta(w, w.bodyText)
        );
    };

    const postJson = <A>(
        url: string,
        bodyObj: A,
        init?: HttpInit & { headers?: Record<string, string> }
    ) => {
        const { headers, ...rest } = init ?? {};
        return mapTryAsync(
            request({
                method: "POST",
                url,
                body: JSON.stringify(bodyObj),
                headers: {
                    "content-type": "application/json",
                    ...(headers ?? {}),
                },
                init: rest,
            }),
            (w) => toResponseWithMeta(w, w.bodyText)
        );
    };

    const getText = (url: string, init?: Omit<RequestInit, "method">) =>
        mapTryAsync(
            request({ method: "GET", url, init }),
            (w) => toResponseWithMeta(w, w.bodyText)
        );

    const getJson = <A>(url: string, init?: Omit<RequestInit, "method">) =>
        mapTryAsync(
            request({ method: "GET", url, init }),
            (w) => toResponseWithMeta(w, JSON.parse(w.bodyText) as A)
        );

    return {
        request,
        getText,
        getJson,
        post,
        postJson,
    };
}

/* ============================================================
 * Streaming client (NUEVO)
 * ============================================================
 */

const toStreamResponse = (w: HttpWireResponseStream): HttpResponseStream => ({
    status: w.status,
    headers: w.headers,
    body: w.body,
});

export type HttpClientDxStream = {
    request: (req: HttpRequest) => Async<unknown, HttpError, HttpResponseStream>;
    get: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpResponseStream>;
    post: (
        url: string,
        body?: string,
        init?: Omit<RequestInit, "method" | "body">
    ) => Async<unknown, HttpError, HttpResponseStream>;
    postJson: <A extends object>(
        url: string,
        body: A,
        init?: Omit<RequestInit, "method" | "body">
    ) => Async<unknown, HttpError, HttpResponseStream>;
};

export function httpClientStream(cfg: MakeHttpConfig = {}): HttpClientDxStream {
    const wire: HttpClientStream = makeHttpStream(cfg);

    const request = (req: HttpRequest) =>
        mapTryAsync(wire(req), toStreamResponse);

    const get = (url: string, init?: Omit<RequestInit, "method">) =>
        request({ method: "GET", url, init });

    const post = (
        url: string,
        body?: string,
        init?: Omit<RequestInit, "method" | "body">
    ) =>
        request({
            method: "POST",
            url,
            body: body && body.length > 0 ? body : undefined,
            init,
        });

    const postJson = <A extends object>(
        url: string,
        bodyObj: A,
        init?: Omit<RequestInit, "method" | "body">
    ) =>
        request({
            method: "POST",
            url,
            body: JSON.stringify(bodyObj),
            headers: {
                "content-type": "application/json",
                ...(init?.headers as any),
            },
            init: { ...(init ?? {}) },
        });

    return {
        request,
        get,
        post,
        postJson,
    };
}
