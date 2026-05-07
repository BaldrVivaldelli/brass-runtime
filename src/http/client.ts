// src/http/client.ts
import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { fromPromiseAbortable, type AbortablePromiseFinish } from "../core/runtime/runtime";
import { ZStream, streamFromReadableStream } from "../core/stream/stream";
import { Request, mergeHeadersUnder } from "./optics/request";
import type { RetryPolicy } from "./retry/retry";
import { sleep } from "../core/runtime/combinators";
import {
    HttpConcurrencyPool,
    resolveHttpPoolKey,
    type HttpPoolConfig,
    type HttpPoolStats,
} from "./pool";

export type HttpError =
    | { _tag: "Abort" }
    | { _tag: "BadUrl"; message: string }
    | { _tag: "FetchError"; message: string }
    | { _tag: "Timeout"; timeoutMs: number; message: string; phase?: "request" | "queue" | "retry" }
    | { _tag: "PoolRejected"; key: string; limit: number; message: string }
    | { _tag: "PoolTimeout"; key: string; timeoutMs: number; message: string };

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
    /** Per-request override for `MakeHttpConfig.timeoutMs`. */
    timeoutMs?: number;
    /** Optional stable key for downstream isolation. When omitted, the pool uses origin/host/global config. */
    poolKey?: string;
};

export type HttpWireResponse = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    ms: number;
};

export type HttpClientStats = {
    readonly inFlight: number;
    readonly started: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly aborted: number;
    readonly timedOut: number;
    readonly poolRejected: number;
    readonly poolTimeouts: number;
    readonly lastDurationMs?: number;
    readonly pool?: HttpPoolStats;
};

export type MakeHttpConfig = {
    baseUrl?: string;
    headers?: Record<string, string>;
    /** Request budget covering pool wait + fetch + body read. Disabled when omitted. */
    timeoutMs?: number;
    /** Downstream pool/concurrency limiter. Disabled by default to preserve existing behavior. */
    pool?: false | HttpPoolConfig;
};

export type HttpWireResponseStream = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: ZStream<unknown, HttpError, Uint8Array>;
    ms: number;
};

export type HttpClientStreamFn = (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponseStream>;
export type HttpClientStream = HttpClientStreamFn & {
    stats: () => HttpClientStats;
};

export type HttpClientFn = (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponse>;
export type HttpMiddleware = (next: HttpClientFn) => HttpClientFn;

export type HttpClient = HttpClientFn & {
    with: (mw: HttpMiddleware) => HttpClient;
    stats: () => HttpClientStats;
};

const emptyStats = (): HttpClientStats => ({
    inFlight: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
    timedOut: 0,
    poolRejected: 0,
    poolTimeouts: 0,
});

export const decorate = (run: HttpClientFn, stats: () => HttpClientStats = emptyStats): HttpClient =>
    Object.assign(((req: HttpRequest) => run(req)) as HttpClientFn, {
        with: (mw: HttpMiddleware) => decorate(mw(run), stats),
        stats,
    });

export const withMiddleware =
    (mw: HttpMiddleware) =>
        (c: HttpClient): HttpClient =>
            decorate(mw(c), c.stats);

const decorateStream = (run: HttpClientStreamFn, stats: () => HttpClientStats = emptyStats): HttpClientStream =>
    Object.assign(((req: HttpRequest) => run(req)) as HttpClientStreamFn, { stats });

const isTaggedHttpError = (e: unknown): e is HttpError => {
    if (typeof e !== "object" || e === null || !("_tag" in e)) return false;
    const tag = (e as any)._tag;
    return tag === "Abort" || tag === "BadUrl" || tag === "FetchError" || tag === "Timeout" || tag === "PoolRejected" || tag === "PoolTimeout";
};

const isAbortError = (e: unknown): boolean =>
    typeof e === "object" && e !== null && "name" in e && (e as any).name === "AbortError";

const normalizeHttpError = (e: unknown): HttpError => {
    if (isTaggedHttpError(e)) return e;
    if (isAbortError(e)) return { _tag: "Abort" };
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

// --- aplica defaults + init.headers usando optics ---
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

const resolvePositiveTimeout = (value: number | undefined): number | undefined => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    const n = Math.floor(value);
    return n > 0 ? n : undefined;
};

type MutableHttpStats = {
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

const makeHttpStats = (pool: HttpConcurrencyPool | undefined) => {
    const stats: MutableHttpStats = {
        inFlight: 0,
        started: 0,
        succeeded: 0,
        failed: 0,
        aborted: 0,
        timedOut: 0,
        poolRejected: 0,
        poolTimeouts: 0,
    };

    const onStart = () => {
        stats.inFlight++;
        stats.started++;
    };

    const onFinish = (finish: AbortablePromiseFinish) => {
        if (stats.inFlight > 0) stats.inFlight--;
        stats.lastDurationMs = finish.durationMs;

        if (finish.outcome === "success") {
            stats.succeeded++;
            return;
        }
        if (finish.outcome === "interrupt") {
            stats.aborted++;
            return;
        }
        if (finish.outcome === "timeout") {
            stats.timedOut++;
            return;
        }

        const err = normalizeHttpError(finish.error);
        switch (err._tag) {
            case "Abort":
                stats.aborted++;
                return;
            case "Timeout":
                stats.timedOut++;
                return;
            case "PoolRejected":
                stats.poolRejected++;
                stats.failed++;
                return;
            case "PoolTimeout":
                stats.poolTimeouts++;
                stats.failed++;
                return;
            default:
                stats.failed++;
                return;
        }
    };

    const snapshot = (): HttpClientStats => ({
        ...stats,
        ...(pool ? { pool: pool.stats() } : {}),
    });

    return { onStart, onFinish, snapshot };
};

const makePool = (cfg: MakeHttpConfig): HttpConcurrencyPool | undefined =>
    cfg.pool === undefined || cfg.pool === false ? undefined : new HttpConcurrencyPool(cfg.pool);

const resolveRequestUrl = (req: HttpRequest, baseUrl: string): URL | HttpError => {
    try {
        return new URL(req.url, baseUrl);
    } catch {
        return { _tag: "BadUrl", message: `URL inválida: ${req.url}` } satisfies HttpError;
    }
};

const headersOf = (res: Response): Record<string, string> => {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return headers;
};

const fetchLabel = (req: HttpRequest, url: URL): string => `http:${req.method}:${url.origin}`;
const timeoutReason = (req: HttpRequest, url: URL, timeoutMs: number): HttpError => ({
    _tag: "Timeout",
    timeoutMs,
    phase: "request",
    message: `HTTP ${req.method} ${url.origin} timed out after ${timeoutMs}ms`,
});

export function makeHttpStream(cfg: MakeHttpConfig = {}): HttpClientStream {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);
    const pool = makePool(cfg);
    const metrics = makeHttpStats(pool);

    const run: HttpClientStreamFn = (req0) => {
        const req = normalize(req0);
        const url = resolveRequestUrl(req, baseUrl);
        if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponseStream>;

        const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

        return fromPromiseAbortable<HttpError, HttpWireResponseStream>(
            async (signal) => {
                let lease: { release: () => void } | undefined;
                try {
                    if (pool) {
                        const key = resolveHttpPoolKey(pool.keyResolver, req, url);
                        lease = await pool.acquire(key, signal);
                    }

                    const started = performance.now();
                    const res = await fetch(url, {
                        ...(req.init ?? {}),
                        method: req.method,
                        headers: Request.headers.get(req),
                        body: req.body,
                        signal,
                    });

                    const headers = headersOf(res);
                    const body = streamFromReadableStream(res.body, normalizeHttpError);

                    // For streaming responses we release at headers to avoid leaking pool slots
                    // when the caller stores/drops the response without consuming the stream.
                    lease?.release();
                    lease = undefined;

                    return {
                        status: res.status,
                        statusText: res.statusText,
                        headers,
                        body,
                        ms: Math.round(performance.now() - started),
                    };
                } finally {
                    lease?.release();
                }
            },
            normalizeHttpError,
            {
                label: fetchLabel(req, url),
                timeoutMs,
                timeoutReason: timeoutMs ? () => timeoutReason(req, url, timeoutMs) : undefined,
                onStart: metrics.onStart,
                onFinish: metrics.onFinish,
            }
        );
    };

    return decorateStream(run, metrics.snapshot);
}

export function makeHttp(cfg: MakeHttpConfig = {}): HttpClient {
    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);
    const pool = makePool(cfg);
    const metrics = makeHttpStats(pool);

    const run: HttpClientFn = (req0) => {
        const req = normalize(req0);
        const url = resolveRequestUrl(req, baseUrl);
        if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponse>;

        const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

        return fromPromiseAbortable<HttpError, HttpWireResponse>(
            async (signal) => {
                let lease: { release: () => void } | undefined;
                try {
                    if (pool) {
                        const key = resolveHttpPoolKey(pool.keyResolver, req, url);
                        lease = await pool.acquire(key, signal);
                    }

                    const started = performance.now();
                    const res = await fetch(url, {
                        ...(req.init ?? {}),
                        method: req.method,
                        headers: Request.headers.get(req),
                        body: req.body,
                        signal,
                    });

                    const bodyText = await res.text();
                    const headers = headersOf(res);

                    return {
                        status: res.status,
                        statusText: res.statusText,
                        headers,
                        bodyText,
                        ms: Math.round(performance.now() - started),
                    };
                } finally {
                    lease?.release();
                }
            },
            normalizeHttpError,
            {
                label: fetchLabel(req, url),
                timeoutMs,
                timeoutReason: timeoutMs ? () => timeoutReason(req, url, timeoutMs) : undefined,
                onStart: metrics.onStart,
                onFinish: metrics.onFinish,
            }
        );
    };

    return decorate(run, metrics.snapshot);
}

// helpers existentes

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const defaultRetryOnError = (e: HttpError) => e._tag === "FetchError" || e._tag === "Timeout" || e._tag === "PoolTimeout";
const defaultRetryOnStatus = (s: number) =>
    s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
const backoffDelayMs = (attempt: number, base: number, cap: number) => {
    const exp = base * Math.pow(2, attempt);
    const lim = clamp(exp, 0, cap);
    return Math.floor(Math.random() * lim);
};

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
  (next: HttpClientStream): HttpClientStream => {
    const retryOnStatus = p.retryOnStatus ?? defaultRetryOnStatus;
    const retryOnError = p.retryOnError ?? defaultRetryOnError;
    const maxElapsedMs = p.maxElapsedMs !== undefined && Number.isFinite(p.maxElapsedMs)
        ? Math.max(0, Math.floor(p.maxElapsedMs))
        : undefined;

    const run: HttpClientStreamFn = (req: Parameters<HttpClientStream>[0]) => {
      type Out = ReturnType<HttpClientStream>; // Async<unknown, HttpError, HttpWireResponseStream>
      const startedAt = performance.now();
      const remainingBudget = () => maxElapsedMs === undefined ? Number.POSITIVE_INFINITY : maxElapsedMs - (performance.now() - startedAt);
      const delayWithinBudget = (delayMs: number) => Math.max(0, Math.min(delayMs, remainingBudget()));

      const loop = (attempt: number): Out =>
        asyncFold(
          next(req),
          (e: HttpError) => {
            // Errores no-reintentables
            if (e._tag === "Abort" || e._tag === "BadUrl" || e._tag === "PoolRejected") return asyncFail(e) as Out;

            const canRetry =
              attempt < p.maxRetries &&
              retryOnError(e) &&
              remainingBudget() > 0;

            if (!canRetry) return asyncFail(e) as Out;

            const d = delayWithinBudget(backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs));
            if (d <= 0 && maxElapsedMs !== undefined) return asyncFail(e) as Out;
            return asyncFlatMap(sleep(d) as any, () => loop(attempt + 1)) as Out;
          },
          (w) => {
            const canRetry =
              attempt < p.maxRetries &&
              retryOnStatus(w.status) &&
              remainingBudget() > 0;

            if (!canRetry) return asyncSucceed(w) as Out;

            const ra = p.respectRetryAfter === false ? undefined : retryAfterMs(w.headers);
            const rawDelay = ra === undefined ? backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs) : Math.min(ra, p.maxDelayMs);
            const d = delayWithinBudget(rawDelay);
            if (d <= 0 && maxElapsedMs !== undefined) return asyncSucceed(w) as Out;

            return asyncFlatMap(sleep(d) as any, () => loop(attempt + 1)) as Out;
          }
        ) as Out;

      return loop(0);
    };

    return decorateStream(run, next.stats);
  };
