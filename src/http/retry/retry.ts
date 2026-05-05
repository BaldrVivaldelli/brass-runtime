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

export const withRetry =
    (p: RetryPolicy): HttpMiddleware =>
        (next: HttpClientFn): HttpClientFn => {
            const retryOnMethods = p.retryOnMethods ?? defaultRetryableMethods;
            const retryOnStatus = p.retryOnStatus ?? defaultRetryOnStatus;
            const retryOnError = p.retryOnError ?? defaultRetryOnError;
            const maxElapsedMs = normalizeBudget(p.maxElapsedMs);

            const isMethodRetryable = (req: HttpRequest) => retryOnMethods.includes(req.method);

            const loop = (req: HttpRequest, attempt: number, startedAt: number): Async<unknown, HttpError, HttpWireResponse> => {
                if (!isMethodRetryable(req)) return next(req);

                const remainingBudget = () =>
                    maxElapsedMs === undefined ? Number.POSITIVE_INFINITY : maxElapsedMs - (performance.now() - startedAt);
                const delayWithinBudget = (delayMs: number) => Math.max(0, Math.min(delayMs, remainingBudget()));

                return asyncFold(
                    next(req),
                    (e) => {
                        if (e._tag === "Abort" || e._tag === "BadUrl" || e._tag === "PoolRejected") return asyncFail(e);

                        const canRetry = attempt < p.maxRetries && retryOnError(e) && remainingBudget() > 0;
                        if (!canRetry) return asyncFail(e);

                        const d = delayWithinBudget(backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs));
                        if (d <= 0 && maxElapsedMs !== undefined) return asyncFail(e);
                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1, startedAt));
                    },
                    (w) => {
                        const canRetry = attempt < p.maxRetries && retryOnStatus(w.status) && remainingBudget() > 0;
                        if (!canRetry) return asyncSucceed(w);

                        const ra = p.respectRetryAfter === false ? undefined : retryAfterMs(w.headers);
                        const rawDelay = ra === undefined ? backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs) : Math.min(ra, p.maxDelayMs);
                        const d = delayWithinBudget(rawDelay);
                        if (d <= 0 && maxElapsedMs !== undefined) return asyncSucceed(w);
                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1, startedAt));
                    }
                );
            };

            return (req) => loop(req, 0, performance.now());
        };
