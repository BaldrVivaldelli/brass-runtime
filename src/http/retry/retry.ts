import type {
    HttpClientFn,
    HttpError,
    HttpMethod,
    HttpMiddleware,
    HttpRequest,
    HttpWireResponse
} from "../client";
import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import { sleepMs } from "../sleep";
import { makeWasmRetryPlanner } from "./wasmRetryPlanner";

export type RetryPolicy = {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;

    /** Optional total retry budget, including request attempts and sleeps. */
    maxElapsedMs?: number;
    /** Defaults to true. When true, Retry-After is honored but capped by maxDelayMs/budget. */
    respectRetryAfter?: boolean;

    retryOnMethods?: HttpMethod[];
    retryOnStatus?: (status: number) => boolean;
    retryOnError?: (e: HttpError) => boolean;

    /** Strict engine selector for retry planning. Defaults to ts. */
    engine?: "ts" | "wasm";
    /** Back-compat knob: wasm=true maps to engine="wasm", wasm=false maps to engine="ts". */
    wasm?: boolean;
};

const defaultRetryableMethods: HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

const defaultRetryOnStatus = (s: number) =>
    s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

const defaultRetryOnError = (e: HttpError) =>
    e._tag === "FetchError" || e._tag === "Timeout" || e._tag === "PoolTimeout";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// “full jitter”: random(0, cap)
const backoffDelayMs = (attempt: number, base: number, cap: number) => {
    const b = Math.max(0, base);
    const c = Math.max(0, cap);
    const exp = b * Math.pow(2, attempt);
    const lim = clamp(exp, 0, c);
    return Math.floor(Math.random() * lim);
};

const headerCI = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? h[k] : undefined;
};

// Retry-After: segundos o HTTP date
const retryAfterMs = (headers: Record<string, string>): number | undefined => {
    const v = headerCI(headers, "retry-after")?.trim();
    if (!v) return undefined;

    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.max(0, Math.floor(secs * 1000));

    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());

    return undefined;
};

const normalizeBudget = (ms: number | undefined): number | undefined => {
    if (ms === undefined || !Number.isFinite(ms)) return undefined;
    return Math.max(0, Math.floor(ms));
};

const resolveRetryEngine = (p: RetryPolicy): "ts" | "wasm" => {
    if (p.engine !== undefined) {
        if (p.engine === "ts" || p.engine === "wasm") return p.engine;
        throw new Error(`brass-runtime retry engine must be 'ts' or 'wasm'; received '${String(p.engine)}'`);
    }
    if (p.wasm === true) return "wasm";
    if (p.wasm === false) return "ts";
    return "ts";
};

export const withRetry =
    (p: RetryPolicy): HttpMiddleware =>
        (next: HttpClientFn): HttpClientFn => {
            const retryOnMethods = p.retryOnMethods ?? defaultRetryableMethods;
            const retryOnStatus = p.retryOnStatus ?? defaultRetryOnStatus;
            const retryOnError = p.retryOnError ?? defaultRetryOnError;
            const maxElapsedMs = normalizeBudget(p.maxElapsedMs);
            const retryEngine = resolveRetryEngine(p);
            const wasmPlanner = retryEngine === "wasm" ? makeWasmRetryPlanner() : undefined;

            const isMethodRetryable = (req: HttpRequest) => retryOnMethods.includes(req.method);

            const nextDelay = (retryId: number | undefined, attempt: number, startedAt: number, retryable: boolean, retryAfter?: number): number | undefined => {
                if (!retryable) return undefined;
                if (wasmPlanner && retryId !== undefined) {
                    return wasmPlanner.nextDelayMs(retryId, {
                        nowMs: performance.now(),
                        retryable,
                        retryAfterMs: retryAfter,
                    });
                }
                const remainingBudget = maxElapsedMs === undefined ? Number.POSITIVE_INFINITY : maxElapsedMs - (performance.now() - startedAt);
                if (remainingBudget <= 0) return undefined;
                const rawDelay = retryAfter === undefined
                    ? backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs)
                    : Math.min(retryAfter, p.maxDelayMs);
                return Math.max(0, Math.min(rawDelay, remainingBudget));
            };

            const dropPlanner = (retryId: number | undefined) => {
                if (retryId !== undefined) wasmPlanner?.drop(retryId);
            };

            const loop = (req: HttpRequest, attempt: number, startedAt: number, retryId: number | undefined): Async<unknown, HttpError, HttpWireResponse> => {
                if (!isMethodRetryable(req)) return next(req);

                const remainingBudget = () =>
                    maxElapsedMs === undefined ? Number.POSITIVE_INFINITY : maxElapsedMs - (performance.now() - startedAt);

                return asyncFold(
                    next(req),
                    (e) => {
                        if (e._tag === "Abort" || e._tag === "BadUrl" || e._tag === "PoolRejected") {
                            dropPlanner(retryId);
                            return asyncFail(e);
                        }

                        const retryable = attempt < p.maxRetries && retryOnError(e) && remainingBudget() > 0;
                        const d = nextDelay(retryId, attempt, startedAt, retryable);
                        if (d === undefined || (d <= 0 && maxElapsedMs !== undefined)) {
                            dropPlanner(retryId);
                            return asyncFail(e);
                        }
                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1, startedAt, retryId));
                    },
                    (w) => {
                        const retryable = attempt < p.maxRetries && retryOnStatus(w.status) && remainingBudget() > 0;
                        const ra = p.respectRetryAfter === false ? undefined : retryAfterMs(w.headers);
                        const d = nextDelay(retryId, attempt, startedAt, retryable, ra);
                        if (d === undefined || (d <= 0 && maxElapsedMs !== undefined)) {
                            dropPlanner(retryId);
                            return asyncSucceed(w);
                        }
                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1, startedAt, retryId));
                    }
                );
            };

            return (req) => {
                if (!isMethodRetryable(req)) return next(req);
                const startedAt = performance.now();
                const retryId = wasmPlanner?.start({
                    nowMs: startedAt,
                    maxRetries: p.maxRetries,
                    baseDelayMs: p.baseDelayMs,
                    maxDelayMs: p.maxDelayMs,
                    maxElapsedMs,
                });
                return loop(req, 0, startedAt, retryId);
            };
        };
