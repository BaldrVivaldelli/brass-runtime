import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { fromPromiseAbortable, type AbortablePromiseFinish } from "../core/runtime/runtime";
import { ZStream } from "../core/stream/stream";
import { Cause, type Exit } from "../core/types/effect";
import { mergeHeadersUnder } from "./optics/request";
import {
    backoffDelayMs,
    defaultRetryOnError,
    defaultRetryableMethods,
    defaultRetryOnStatus,
    normalizeRetryBudget,
    retryAfterMs,
    type RetryPolicy,
} from "./retry/retry";
import { sleep } from "../core/runtime/combinators";
import {
    HttpConcurrencyPool,
    resolveHttpPoolKey,
    type HttpPoolConfig,
    type HttpPoolStats,
} from "./pool";
import { AdaptiveLimiter, type AdaptiveLimiterConfig, type AdaptiveLimiterStats } from "./adaptiveLimiter";
import { validateMakeHttpConfig } from "./configValidation";
import { registerHttpEffect, type EffectCanceler } from "./effectRunner";
import {
    abortErrorForSignal,
    linkAbortSignals,
    makeFetchStreamTransport,
    makeFetchTransport,
    normalizeHttpError,
    type HttpStreamTransport,
    type HttpTransport,
} from "./transport";
import { getHttpRequestPolicy } from "./requestPolicy";
import type { HttpRequestPolicyRef, HttpRequestRetryOverride } from "./requestPolicy";

export type HttpError =
    | { _tag: "Abort" }
    | { _tag: "BadUrl"; message: string }
    | { _tag: "FetchError"; message: string; code?: string; status?: number; statusText?: string; retryAfterMs?: number; cause?: unknown }
    | { _tag: "Timeout"; timeoutMs: number; message: string; phase?: "request" | "queue" | "retry" }
    | { _tag: "PoolRejected"; key: string; limit: number; message: string; retryAfterMs?: number }
    | { _tag: "PoolTimeout"; key: string; timeoutMs: number; message: string }
    | { _tag: "PoolClosed"; key: string; message: string }
    | { _tag: "BatchSplitError"; expected: number; actual: number; message: string };

export type HttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";

export type HttpInit = Omit<RequestInit, "method" | "body" | "headers">;
export type HttpBody = string | Uint8Array | ArrayBuffer;

export type HttpRequest = {
    method: HttpMethod;
    url: string; // relative o absolute
    headers?: Record<string, string>;
    body?: HttpBody;
    init?: HttpInit;
    /** Structured per-request execution policy. Legacy top-level fields are still read. */
    policy?: HttpRequestPolicyRef;
    /** Per-request override for `MakeHttpConfig.timeoutMs`. */
    timeoutMs?: number;
    /** Optional stable key for downstream isolation. When omitted, the pool uses origin/host/global config. */
    poolKey?: string;
    /** @deprecated Use `policy.lane`. Kept for middleware interop. */
    lane?: string;
    /** @deprecated Use `policy.dedupKey`. Kept for middleware interop. */
    dedupKey?: string;
    /** @deprecated Use `policy.priority`. Kept for middleware interop. */
    priority?: number;
    /** @deprecated Use `policy.retry`. Kept for middleware interop. */
    retry?: HttpRequestRetryOverride;
};

export type HttpWireResponse<Meta = unknown> = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    ms: number;
    transportMeta?: Meta;
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
    readonly adaptiveLimiter?: AdaptiveLimiterStats;
};

export type MakeHttpConfig = {
    baseUrl?: string;
    headers?: Record<string, string>;
    /** Request budget covering pool wait + fetch + body read. Disabled when omitted. */
    timeoutMs?: number;
    /** Effect-based transport. Defaults to `fetch`; provide one for axios/undici/test transports. */
    transport?: HttpTransport;
    /** Effect-based streaming transport. Defaults to `fetch` streaming. */
    streamTransport?: HttpStreamTransport;
    /** Downstream pool/concurrency limiter. Disabled by default to preserve existing behavior. */
    pool?: false | HttpPoolConfig;
    /** Adaptive concurrency limiter. Replaces fixed pool when enabled. */
    adaptiveLimiter?: false | AdaptiveLimiterConfig;
};

export type HttpWireResponseStream<Meta = unknown> = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: ZStream<unknown, HttpError, Uint8Array>;
    ms: number;
    transportMeta?: Meta;
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
    adaptiveLimiter?: AdaptiveLimiter;
    destroy?: () => void;
    shutdown?: () => void;
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

type HttpClientMetadata = Pick<HttpClient, "adaptiveLimiter" | "destroy" | "shutdown">;

export const decorate = (
    run: HttpClientFn,
    stats: () => HttpClientStats = emptyStats,
    metadata: HttpClientMetadata = {},
): HttpClient => {
    const clientFn = ((req: HttpRequest) => run(req)) as HttpClientFn;
    Object.assign(clientFn, metadata);
    return Object.assign(clientFn, {
        with: (mw: HttpMiddleware) => decorate(mw(clientFn), stats, metadata),
        stats,
    }, metadata);
};

export const withMiddleware =
    (mw: HttpMiddleware) =>
        (c: HttpClient): HttpClient =>
            decorate(mw(c), c.stats, {
                adaptiveLimiter: c.adaptiveLimiter,
                destroy: c.destroy,
                shutdown: c.shutdown,
            });

const decorateStream = (run: HttpClientStreamFn, stats: () => HttpClientStats = emptyStats): HttpClientStream =>
    Object.assign(((req: HttpRequest) => run(req)) as HttpClientStreamFn, { stats });

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

const makeHttpStats = (
    pool: HttpConcurrencyPool | undefined,
    adaptiveLimiter: AdaptiveLimiter | undefined,
) => {
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
        ...(adaptiveLimiter ? { adaptiveLimiter: adaptiveLimiter.stats() } : {}),
    });

    return { onStart, onFinish, snapshot };
};

const makePool = (cfg: MakeHttpConfig): HttpConcurrencyPool | undefined =>
    cfg.pool === undefined || cfg.pool === false ? undefined : new HttpConcurrencyPool(cfg.pool);

const makeAdaptiveLimiter = (cfg: MakeHttpConfig): AdaptiveLimiter | undefined =>
    cfg.adaptiveLimiter === undefined || cfg.adaptiveLimiter === false ? undefined : new AdaptiveLimiter(cfg.adaptiveLimiter);

const resolveRequestUrl = (req: HttpRequest, baseUrl: string): URL | HttpError => {
    try {
        return new URL(req.url, baseUrl);
    } catch {
        return { _tag: "BadUrl", message: `URL inválida: ${req.url}` } satisfies HttpError;
    }
};

const fetchLabel = (req: HttpRequest, url: URL): string => `http:${req.method}:${url.origin}`;
const timeoutReason = (req: HttpRequest, url: URL, timeoutMs: number): HttpError => ({
    _tag: "Timeout",
    timeoutMs,
    phase: "request",
    message: `HTTP ${req.method} ${url.origin} timed out after ${timeoutMs}ms`,
});

const requestPriority = (req: HttpRequest): number | undefined => {
    const fromPolicy = getHttpRequestPolicy(req).priority;
    if (fromPolicy !== undefined) return fromPolicy;
    return (req.init as any)?.priority;
};

const exitError = <E, A>(exit: Exit<E, A>): unknown => {
    if (exit._tag === "Success") return undefined;
    const failure = Cause.firstFailure(exit.cause);
    if (failure._tag === "Some") return failure.value;
    const defect = Cause.firstDefect(exit.cause);
    if (defect._tag === "Some") return defect.value;
    if (Cause.containsInterrupt(exit.cause)) return { _tag: "Abort" } satisfies HttpError;
    return Cause.toError(exit.cause);
};

const runTransportEffect = <A>(
    effect: Async<unknown, HttpError, A>,
    env: unknown,
    signal: AbortSignal,
): Promise<A> =>
    new Promise((resolve, reject) => {
        let done = false;
        let cancel: EffectCanceler | undefined;

        const finish = (exit: Exit<HttpError, A>) => {
            if (done) return;
            done = true;
            signal.removeEventListener("abort", abort);
            cancel = undefined;
            if (exit._tag === "Success") {
                resolve(exit.value);
                return;
            }
            reject(exitError(exit));
        };

        const abort = () => {
            if (done) return;
            done = true;
            signal.removeEventListener("abort", abort);
            const currentCancel = cancel;
            cancel = undefined;
            currentCancel?.();
            reject(abortErrorForSignal(signal));
        };

        if (signal.aborted) {
            abort();
            return;
        }

        signal.addEventListener("abort", abort, { once: true });

        try {
            cancel = registerHttpEffect(effect, env, finish);
        } catch (error) {
            if (done) return;
            done = true;
            signal.removeEventListener("abort", abort);
            reject(error);
        }
    });

type HttpLease = { release: (...args: any[]) => void };

const releaseSuccess = (
    lease: HttpLease | undefined,
    adaptiveLimiter: AdaptiveLimiter | undefined,
    response: { readonly status: number; readonly ms: number },
): undefined => {
    if (!lease) return undefined;
    if (adaptiveLimiter) {
        lease.release(response.ms, { status: response.status });
    } else {
        lease.release();
    }
    return undefined;
};

const releaseFailure = (
    lease: HttpLease | undefined,
    adaptiveLimiter: AdaptiveLimiter | undefined,
): undefined => {
    if (!lease) return undefined;
    if (adaptiveLimiter) {
        lease.release(0, { error: true });
    } else {
        lease.release();
    }
    return undefined;
};

export function makeHttpStream(cfg: MakeHttpConfig = {}): HttpClientStream {
    validateMakeHttpConfig(cfg);

    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);
    const adaptiveLimiter = makeAdaptiveLimiter(cfg);
    const pool = adaptiveLimiter ? undefined : makePool(cfg);
    const metrics = makeHttpStats(pool, adaptiveLimiter);
    const transport = cfg.streamTransport ?? makeFetchStreamTransport();

    const run: HttpClientStreamFn = (req0) => {
        const req = normalize(req0);
        const url = resolveRequestUrl(req, baseUrl);
        if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponseStream>;

        const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

        return fromPromiseAbortable<HttpError, HttpWireResponseStream>(
            async (signal, env) => {
                let lease: HttpLease | undefined;
                const linkedSignal = linkAbortSignals(signal, (req.init as { signal?: AbortSignal } | undefined)?.signal);
                try {
                    if (linkedSignal.signal.aborted) throw abortErrorForSignal(linkedSignal.signal);
                    if (adaptiveLimiter) {
                        const key = resolveHttpPoolKey(adaptiveLimiter.keyResolver, req, url);
                        lease = await adaptiveLimiter.acquire(key, linkedSignal.signal, { priority: requestPriority(req) });
                    } else if (pool) {
                        const key = resolveHttpPoolKey(pool.keyResolver, req, url);
                        lease = await pool.acquire(key, linkedSignal.signal);
                    }

                    const response = await runTransportEffect(
                        transport({ request: req, url, signal: linkedSignal.signal }),
                        env,
                        linkedSignal.signal,
                    );
                    lease = releaseSuccess(lease, adaptiveLimiter, response);

                    // Streaming responses release at headers. The body stream owns
                    // its host-resource cleanup after this effect succeeds.
                    lease = undefined;
                    return response;
                } finally {
                    linkedSignal.cleanup();
                    if (lease) {
                        releaseFailure(lease, adaptiveLimiter);
                    }
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
    validateMakeHttpConfig(cfg);

    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);
    const adaptiveLimiter = makeAdaptiveLimiter(cfg);
    const pool = adaptiveLimiter ? undefined : makePool(cfg);
    const metrics = makeHttpStats(pool, adaptiveLimiter);
    const transport = cfg.transport ?? makeFetchTransport();

    const run: HttpClientFn = (req0) => {
        const req = normalize(req0);
        const url = resolveRequestUrl(req, baseUrl);
        if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponse>;

        const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

        return fromPromiseAbortable<HttpError, HttpWireResponse>(
            async (signal, env) => {
                let lease: HttpLease | undefined;
                const linkedSignal = linkAbortSignals(signal, (req.init as { signal?: AbortSignal } | undefined)?.signal);
                try {
                    if (linkedSignal.signal.aborted) throw abortErrorForSignal(linkedSignal.signal);
                    if (adaptiveLimiter) {
                        const key = resolveHttpPoolKey(adaptiveLimiter.keyResolver, req, url);
                        lease = await adaptiveLimiter.acquire(key, linkedSignal.signal, { priority: requestPriority(req) });
                    } else if (pool) {
                        const key = resolveHttpPoolKey(pool.keyResolver, req, url);
                        lease = await pool.acquire(key, linkedSignal.signal);
                    }

                    const response = await runTransportEffect(
                        transport({ request: req, url, signal: linkedSignal.signal }),
                        env,
                        linkedSignal.signal,
                    );
                    lease = releaseSuccess(lease, adaptiveLimiter, response);
                    return response;
                } finally {
                    linkedSignal.cleanup();
                    if (lease) {
                        releaseFailure(lease, adaptiveLimiter);
                    }
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

    return decorate(run, metrics.snapshot, adaptiveLimiter ? {
        adaptiveLimiter,
        destroy: () => adaptiveLimiter.destroy(),
        shutdown: () => adaptiveLimiter.shutdown(),
    } : {});
}

export const withRetryStream =
  (p: RetryPolicy) =>
  (next: HttpClientStream): HttpClientStream => {
    const retryOnStatus = p.retryOnStatus ?? defaultRetryOnStatus;
    const retryOnError = p.retryOnError ?? defaultRetryOnError;
    const retryOnMethods = p.retryOnMethods ?? defaultRetryableMethods;
    const maxElapsedMs = normalizeRetryBudget(p.maxElapsedMs);

    const run: HttpClientStreamFn = (req: Parameters<HttpClientStream>[0]) => {
      type Out = ReturnType<HttpClientStream>; // Async<unknown, HttpError, HttpWireResponseStream>
      if (!retryOnMethods.includes(req.method)) return next(req) as Out;

      const startedAt = performance.now();
      const remainingBudget = () => maxElapsedMs === undefined ? Number.POSITIVE_INFINITY : maxElapsedMs - (performance.now() - startedAt);
      const delayWithinBudget = (delayMs: number) => Math.max(0, Math.min(delayMs, remainingBudget()));

      const loop = (attempt: number): Out =>
        asyncFold(
          next(req),
          (e: HttpError) => {
            // Errores no-reintentables
            if (e._tag === "Abort" || e._tag === "BadUrl" || e._tag === "PoolRejected" || e._tag === "PoolClosed") return asyncFail(e) as Out;

            const canRetry =
              attempt < p.maxRetries &&
              retryOnError(e) &&
              remainingBudget() > 0;

            if (!canRetry) return asyncFail(e) as Out;

            const d = delayWithinBudget(backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs));
            if (d <= 0 && maxElapsedMs !== undefined) return asyncFail(e) as Out;
            p.onRetry?.({
              attempt,
              delayMs: d,
              error: e,
              status: undefined,
              url: req.url,
              method: req.method,
              timestamp: Date.now(),
            });
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

            p.onRetry?.({
              attempt,
              delayMs: d,
              error: undefined,
              status: w.status,
              url: req.url,
              method: req.method,
              timestamp: Date.now(),
            });
            return asyncFlatMap(sleep(d) as any, () => loop(attempt + 1)) as Out;
          }
        ) as Out;

      return loop(0);
    };

    return decorateStream(run, next.stats);
  };
