// src/runtime/client.ts

import {Async} from "../types/asyncEffect";
import {fromPromiseAbortable} from "../runtime/runtime";

export type HttpError =
    | { _tag: "Abort" }
    | { _tag: "BadUrl"; message: string }
    | { _tag: "FetchError"; message: string };

export type ResponseSpec = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    ms: number;
};

export type HttpClient = {
    get: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, ResponseSpec>;
    post: (url: string, body?: string, init?: Omit<RequestInit, "method" | "body">) => Async<unknown, HttpError, ResponseSpec>;

    getText: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, string>;
    getJson: <A>(url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, A>;

    postJson: <A extends object>(url: string, body: A, init?: Omit<RequestInit, "method" | "body">) => Async<unknown, HttpError, ResponseSpec>;
};

type MakeHttpConfig = {
    baseUrl?: string;
    headers?: Record<string, string>;
};

const normalizeHttpError = (e: unknown): HttpError => {
    if (e instanceof DOMException && e.name === "AbortError") return { _tag: "Abort" };
    if (typeof e === "object" && e && "_tag" in e) return e as HttpError;
    return { _tag: "FetchError", message: String(e) };
};

export function makeHttp(cfg: MakeHttpConfig = {}): HttpClient {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};

    const send = (req: RequestInit & { url: string }) =>
        fromPromiseAbortable<HttpError, ResponseSpec>(
            async (signal) => {
                let url: URL;
                try {
                    url = new URL(req.url, baseUrl);
                } catch {
                    throw { _tag: "BadUrl", message: `URL inválida: ${req.url}` } satisfies HttpError;
                }

                const started = performance.now();

                const res = await fetch(url, {
                    ...req,
                    headers: { ...defaultHeaders, ...(req.headers ?? {}) },
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

    return {
        get: (url, init) => send({ url, method: "GET", ...(init ?? {}) }),
        post: (url, body, init) =>
            send({ url, method: "POST", body: body && body.length > 0 ? body : undefined, ...(init ?? {}) }),

        getText: (url, init) =>
            // si querés, esto podría mappear ResponseSpec -> bodyText con asyncMap
            // pero lo dejo directo para que se entienda
            // @ts-ignore: reemplazá con tu asyncMap si lo tenés importado
            send({ url, method: "GET", ...(init ?? {}) }).map((r: ResponseSpec) => r.bodyText),

        getJson: <A>(url: string, init?: Omit<RequestInit, "method">) =>
            // @ts-ignore idem: reemplazá con tu composición real (flatMap/map)
            send({ url, method: "GET", ...(init ?? {}) }).map((r: ResponseSpec) => JSON.parse(r.bodyText) as A),

        postJson: (url, bodyObj, init) =>
            send({
                url,
                method: "POST",
                headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
                body: JSON.stringify(bodyObj),
                ...(init ?? {}),
            }),
    };
}
