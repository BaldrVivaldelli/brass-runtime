import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import { fromPromiseAbortable, recordAbortablePromiseStart, recordAbortablePromiseFinish, type AbortablePromiseFinish } from "../core/runtime/runtime";
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
import { TimerWheel } from "./timerWheel";
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

type HttpMetrics = ReturnType<typeof makeHttpStats>;

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

const runDirectTransport = (
    req: HttpRequest,
    url: URL,
    transport: HttpTransport,
    metrics: HttpMetrics,
): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        const controller = new AbortController();
        const previousSignal = (req.init as { signal?: AbortSignal } | undefined)?.signal;
        const label = fetchLabel(req, url);
        const startedAt = performance.now();
        let done = false;
        let cancelInner: EffectCanceler | undefined;

        const cleanup = () => {
            previousSignal?.removeEventListener("abort", abortFromPrevious);
        };

        const finish = (
            outcome: AbortablePromiseFinish["outcome"],
            exit: Exit<HttpError, HttpWireResponse>,
            error?: unknown,
        ) => {
            if (done) return;
            done = true;
            cleanup();
            metrics.onFinish({
                label,
                outcome,
                durationMs: Math.round(performance.now() - startedAt),
                error,
            });
            cb(exit);
        };

        const finishFailure = (error: HttpError, outcome: AbortablePromiseFinish["outcome"] = "failure") => {
            finish(outcome, { _tag: "Failure", cause: Cause.fail(error) }, error);
        };

        const abortCurrent = (reason?: unknown) => {
            try {
                controller.abort(reason);
            } catch {
                controller.abort();
            }
        };

        function abortFromPrevious() {
            const error = previousSignal ? abortErrorForSignal(previousSignal) : ({ _tag: "Abort" } satisfies HttpError);
            abortCurrent(previousSignal?.reason);
            const cancel = cancelInner;
            cancelInner = undefined;
            queueMicrotask(() => {
                finishFailure(error);
                cancel?.();
            });
        }

        metrics.onStart();

        if (previousSignal?.aborted) {
            abortFromPrevious();
            return () => undefined;
        }

        previousSignal?.addEventListener("abort", abortFromPrevious, { once: true });

        try {
            const innerCancel = registerHttpEffect(
                transport({ request: req, url, signal: controller.signal }),
                env,
                (exit) => {
                    if (exit._tag === "Success") {
                        finish("success", exit);
                        cancelInner = undefined;
                        return;
                    }
                    finish("failure", exit, exitError(exit));
                    cancelInner = undefined;
                },
            );
            if (!done) cancelInner = innerCancel;
        } catch (error) {
            finishFailure(normalizeHttpError(error));
        }

        return () => {
            if (done) return;
            const cancel = cancelInner;
            cancelInner = undefined;
            abortCurrent();
            finish("interrupt", { _tag: "Failure", cause: Cause.interrupt() });
            cancel?.();
        };
    },
});

const transportDestroy = (transport: HttpTransport | HttpStreamTransport): (() => void) | undefined => {
    const destroy = (transport as { destroy?: unknown }).destroy;
    return typeof destroy === "function" ? () => destroy.call(transport) : undefined;
};

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

/**
 * Shared frozen options object for addEventListener calls — avoids allocating
 * a new `{ once: true }` object per request.
 */
const ONCE_OPTIONS: AddEventListenerOptions = Object.freeze({ once: true });

/**
 * Shared no-op AbortSignal used when no external signal is present.
 * This avoids allocating a new AbortController per request in the common case.
 */
export const noopSignal: AbortSignal = (() => {
    const c = new AbortController();
    const s = c.signal;
    // Register globally so the transport layer can detect it without a circular import
    (globalThis as any).__brassNoopSignal = s;
    return s;
})();

/**
 * Per-request state object for pool transport. Hoists shared logic as methods
 * so the uncontended sync path allocates at most 3 closures:
 *   1. The cancel function returned to caller
 *   2. The transport completion callback (success/failure handler)
 *   3. The timeout callback (when timeoutMs is set)
 *
 * All other functions (finish, finishFailure, abortCurrent, abortFromPrevious,
 * runTransportInner) are methods on this object — no per-request closure allocation.
 */
class PoolRequestState {
    done = false;
    cancelInner: EffectCanceler | undefined = undefined;
    timerHandle: { cancel(): void } | undefined = undefined;
    timeoutHandle: ReturnType<typeof setTimeout> | undefined = undefined;
    lease: HttpLease | undefined = undefined;

    constructor(
        readonly req: HttpRequest,
        readonly url: URL,
        readonly transport: HttpTransport,
        readonly metrics: HttpMetrics,
        readonly pool: HttpConcurrencyPool | undefined,
        readonly adaptiveLimiter: AdaptiveLimiter | undefined,
        readonly timerWheel: TimerWheel | undefined,
        readonly timeoutMs: number | undefined,
        readonly env: unknown,
        readonly cb: (exit: Exit<HttpError, HttpWireResponse>) => void,
        readonly previousSignal: AbortSignal | undefined,
        readonly controller: AbortController | undefined,
        readonly signal: AbortSignal,
        readonly label: string,
        readonly startedAt: number,
    ) {}

    finish(
        outcome: AbortablePromiseFinish["outcome"],
        exit: Exit<HttpError, HttpWireResponse>,
        error?: unknown,
    ): void {
        if (this.done) return;
        this.done = true;
        // Cleanup timeout
        if (this.timerHandle) { this.timerHandle.cancel(); this.timerHandle = undefined; }
        if (this.timeoutHandle !== undefined) { clearTimeout(this.timeoutHandle); this.timeoutHandle = undefined; }
        // Cleanup signal listeners — only when external signal is present
        if (this.previousSignal) this.previousSignal.removeEventListener("abort", this.boundAbortFromPrevious!);
        this.cancelInner = undefined;
        recordAbortablePromiseFinish(this.label, outcome);
        this.metrics.onFinish({
            label: this.label,
            outcome,
            durationMs: Math.round(performance.now() - this.startedAt),
            error,
        });
        this.cb(exit);
    }

    finishFailure(error: HttpError, outcome: AbortablePromiseFinish["outcome"] = "failure"): void {
        this.finish(outcome, { _tag: "Failure", cause: Cause.fail(error) }, error);
    }

    abortCurrent(reason?: unknown): void {
        if (!this.controller) return;
        try { this.controller.abort(reason); } catch { this.controller.abort(); }
    }

    /**
     * Bound reference for addEventListener/removeEventListener.
     * Only allocated when previousSignal is present (not on the hot path).
     */
    boundAbortFromPrevious: (() => void) | undefined = undefined;

    abortFromPrevious(): void {
        const error = this.previousSignal ? abortErrorForSignal(this.previousSignal) : ({ _tag: "Abort" } satisfies HttpError);
        this.abortCurrent(this.previousSignal?.reason);
        const cancel = this.cancelInner;
        this.cancelInner = undefined;
        // Release lease eagerly so the direct promise path (which has no
        // cancelInner) does not leak the permit when the rejection handler
        // fires after done is already set.
        if (this.lease) { releaseFailure(this.lease, this.adaptiveLimiter); this.lease = undefined; }
        // Use queueMicrotask to avoid re-entrancy issues with signal listeners
        queueMicrotask(() => {
            this.finishFailure(error);
            cancel?.();
        });
    }

    runTransportInner(): void {
        const { transport, req, url, signal, env } = this;
        // Use the effect-based path for all transports (including promise transports).
        // The effect path uses callback-based resolution which avoids the extra microtask
        // tick that the Promise-based requestDirect path introduces via .then() chaining.
        // Since task 4.1 added fast-path bypass for bare Async effects, the effect path
        // is equally efficient for simple transports while having one fewer microtask tick.
        // Closure #2: transport completion callback
        try {
            const effect = transport({ request: req, url, signal });
            // FAST PATH: Succeed/Fail effects — resolve immediately, no interpreter needed.
            if (effect._tag === "Succeed") {
                if (this.lease) releaseSuccess(this.lease, this.adaptiveLimiter, (effect as any).value);
                this.finish("success", { _tag: "Success", value: (effect as any).value });
            } else if (effect._tag === "Fail") {
                if (this.lease) releaseFailure(this.lease, this.adaptiveLimiter);
                this.finishFailure((effect as any).error);
            } else if (effect._tag === "Async") {
                try {
                    const cancel = effect.register(env, (exit) => {
                        if (this.done) return;
                        this.cancelInner = undefined;
                        if (exit._tag === "Success") {
                            if (this.lease) releaseSuccess(this.lease, this.adaptiveLimiter, exit.value);
                            this.finish("success", exit);
                        } else {
                            if (this.lease) releaseFailure(this.lease, this.adaptiveLimiter);
                            this.finish("failure", exit, exitError(exit));
                        }
                    });
                    if (!this.done) this.cancelInner = typeof cancel === "function" ? cancel : undefined;
                } catch (error) {
                    if (this.lease) releaseFailure(this.lease, this.adaptiveLimiter);
                    this.finishFailure(normalizeHttpError(error));
                }
            } else {
                const innerCancel = registerHttpEffect(
                    effect,
                    env,
                    (exit) => {
                        if (this.done) return;
                        this.cancelInner = undefined;
                        if (exit._tag === "Success") {
                            if (this.lease) releaseSuccess(this.lease, this.adaptiveLimiter, exit.value);
                            this.finish("success", exit as Exit<HttpError, HttpWireResponse>);
                        } else {
                            if (this.lease) releaseFailure(this.lease, this.adaptiveLimiter);
                            this.finish("failure", exit as Exit<HttpError, HttpWireResponse>, exitError(exit));
                        }
                    },
                );
                if (!this.done) this.cancelInner = innerCancel;
            }
        } catch (error) {
            if (this.lease) releaseFailure(this.lease, this.adaptiveLimiter);
            this.finishFailure(normalizeHttpError(error));
        }
    }
}

/**
 * Synchronous fast-path for pool/adaptive-limiter + timeout requests.
 *
 * When the pool/limiter acquire is uncontended (tryAcquireSync succeeds) and the
 * transport effect resolves synchronously, this avoids ALL Promise/microtask
 * boundaries — the entire request completes in a single call frame.
 *
 * Falls back to async acquire when contended (pool full or limiter at limit).
 *
 * Closure budget for uncontended sync path:
 *   1. The cancel function returned to caller
 *   2. The transport completion callback (success/failure handler)
 *   3. The timeout callback (when timeoutMs is set)
 * All other functions are methods on PoolRequestState — no per-request closure allocation.
 */
const runPoolTransport = (
    req: HttpRequest,
    url: URL,
    transport: HttpTransport,
    metrics: HttpMetrics,
    pool: HttpConcurrencyPool | undefined,
    adaptiveLimiter: AdaptiveLimiter | undefined,
    timerWheel: TimerWheel | undefined,
    timeoutMs: number | undefined,
): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        const previousSignal = (req.init as { signal?: AbortSignal } | undefined)?.signal;
        // Keep a real controller on the pool/timeout path. Promise transports
        // such as Axios rely on the signal being aborted for timeout/cancel to
        // stop the host request, not only to ignore its late settlement.
        const controller = new AbortController();
        const signal = controller.signal;
        const label = fetchLabel(req, url);
        const startedAt = performance.now();

        // Per-request state object — all shared logic lives as methods here.
        const state = new PoolRequestState(
            req, url, transport, metrics, pool, adaptiveLimiter,
            timerWheel, timeoutMs, env, cb, previousSignal, controller,
            signal, label, startedAt,
        );

        recordAbortablePromiseStart(label);
        metrics.onStart();

        // Only allocate the bound abort listener when an external signal is present.
        // This keeps the uncontended path (no external signal) at 0 extra closures for abort handling.
        if (previousSignal) {
            state.boundAbortFromPrevious = () => state.abortFromPrevious();

            // Check pre-aborted signal
            if (previousSignal.aborted) {
                state.abortFromPrevious();
                return () => undefined;
            }

            previousSignal.addEventListener("abort", state.boundAbortFromPrevious, ONCE_OPTIONS);
        }

        // Setup timeout via timer wheel or setTimeout.
        // Closure #3 (only when timeoutMs is set): the timeout callback.
        if (timeoutMs !== undefined && timeoutMs > 0) {
            const onTimeout = () => {
                const reason = timeoutReason(req, url, timeoutMs);
                // Finish with timeout FIRST (sets done=true), then abort/cancel
                // so inner effect callbacks are no-ops.
                if (state.lease) { releaseFailure(state.lease, adaptiveLimiter); state.lease = undefined; }
                const cancel = state.cancelInner;
                state.cancelInner = undefined;
                state.finishFailure(reason, "timeout");
                state.abortCurrent(reason);
                cancel?.();
            };
            if (timerWheel) {
                state.timerHandle = timerWheel.schedule(timeoutMs, onTimeout, startedAt);
            } else {
                state.timeoutHandle = setTimeout(onTimeout, timeoutMs);
            }
        }

        // Pool/limiter acquire — try sync first (no Promise, no microtask)
        if (adaptiveLimiter) {
            const key = resolveHttpPoolKey(adaptiveLimiter.keyResolver, req, url);
            const syncLease = adaptiveLimiter.tryAcquireSync(key, signal);
            if (syncLease) {
                state.lease = syncLease;
            } else {
                // Contended — fall back to async acquire then run transport
                adaptiveLimiter.acquire(key, signal, { priority: requestPriority(req) }).then(
                    (asyncLease) => {
                        if (state.done) { asyncLease.release(0); return; }
                        state.lease = asyncLease;
                        state.runTransportInner();
                    },
                    (err) => {
                        if (state.done) return;
                        state.finishFailure(normalizeHttpError(err));
                    },
                );
                // Closure #1: cancel function returned to caller
                return () => {
                    if (state.done) return;
                    const cancel = state.cancelInner;
                    state.cancelInner = undefined;
                    state.abortCurrent();
                    if (state.lease) releaseFailure(state.lease, adaptiveLimiter);
                    state.finish("interrupt", { _tag: "Failure", cause: Cause.interrupt() });
                    cancel?.();
                };
            }
        } else if (pool) {
            const key = resolveHttpPoolKey(pool.keyResolver, req, url);
            const syncLease = pool.tryAcquireSync(key, signal);
            if (syncLease) {
                state.lease = syncLease;
            } else {
                // Contended — fall back to async acquire then run transport
                pool.acquire(key, signal).then(
                    (asyncLease) => {
                        if (state.done) { asyncLease.release(); return; }
                        state.lease = asyncLease;
                        state.runTransportInner();
                    },
                    (err) => {
                        if (state.done) return;
                        state.finishFailure(normalizeHttpError(err));
                    },
                );
                // Closure #1: cancel function returned to caller
                return () => {
                    if (state.done) return;
                    const cancel = state.cancelInner;
                    state.cancelInner = undefined;
                    state.abortCurrent();
                    if (state.lease) releaseFailure(state.lease, undefined);
                    state.finish("interrupt", { _tag: "Failure", cause: Cause.interrupt() });
                    cancel?.();
                };
            }
        }

        // Run transport synchronously (common uncontended path — no Promise/microtask)
        state.runTransportInner();

        // Closure #1: cancel function returned to caller
        return () => {
            if (state.done) return;
            const cancel = state.cancelInner;
            state.cancelInner = undefined;
            state.abortCurrent();
            if (state.lease) releaseFailure(state.lease, adaptiveLimiter);
            state.finish("interrupt", { _tag: "Failure", cause: Cause.interrupt() });
            cancel?.();
        };
    },
});

export function makeHttp(cfg: MakeHttpConfig = {}): HttpClient {
    validateMakeHttpConfig(cfg);

    const baseUrl = cfg.baseUrl ?? "";
    const defaultHeaders = cfg.headers ?? {};
    const normalize = normalizeRequest(defaultHeaders);
    const adaptiveLimiter = makeAdaptiveLimiter(cfg);
    const pool = adaptiveLimiter ? undefined : makePool(cfg);
    const metrics = makeHttpStats(pool, adaptiveLimiter);
    const transport = cfg.transport ?? makeFetchTransport();
    const destroyTransport = transportDestroy(transport);

    const run: HttpClientFn = (req0) => {
        const req = normalize(req0);
        const url = resolveRequestUrl(req, baseUrl);
        if (!(url instanceof URL)) return asyncFail(url) as Async<unknown, HttpError, HttpWireResponse>;

        const timeoutMs = resolvePositiveTimeout(req.timeoutMs ?? cfg.timeoutMs);

        if (!adaptiveLimiter && !pool && timeoutMs === undefined) {
            return runDirectTransport(req, url, transport, metrics);
        }

        return runPoolTransport(req, url, transport, metrics, pool, adaptiveLimiter, undefined, timeoutMs);
    };

    const metadata: HttpClientMetadata = {};
    if (adaptiveLimiter) metadata.adaptiveLimiter = adaptiveLimiter;
    if (adaptiveLimiter || destroyTransport) {
        metadata.destroy = () => {
            adaptiveLimiter?.destroy();
            destroyTransport?.();
        };
        metadata.shutdown = () => {
            adaptiveLimiter?.shutdown();
            destroyTransport?.();
        };
    }

    return decorate(run, metrics.snapshot, metadata);
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
