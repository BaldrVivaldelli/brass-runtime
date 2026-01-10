import {HttpClient, HttpError, HttpMethod, HttpRequest, HttpWireResponse} from "../client";
import {Async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed} from "../../core/types/asyncEffect";
import {fromPromiseAbortable} from "../../core/runtime/runtime";

export type RetryPolicy = {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;

    retryOnMethods?: HttpMethod[];
    retryOnStatus?: (status: number) => boolean;
    retryOnError?: (e: HttpError) => boolean;
};

const defaultRetryableMethods: HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

const defaultRetryOnStatus = (s: number) =>
    s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

const defaultRetryOnError = (e: HttpError) => e._tag === "FetchError";

const normalizeHttpError = (e: unknown): HttpError => {
    // AbortError (browser / node18+)
    if (typeof e === "object" && e !== null && "name" in e && (e as any).name === "AbortError") {
        return { _tag: "Abort" };
    }
    if (typeof e === "object" && e && "_tag" in (e as any)) return e as HttpError;
    return { _tag: "FetchError", message: String(e) };
};

// sleep cancelable (si el fiber se interrumpe, cancela el timer)
const sleepMs = (ms: number): Async<unknown, HttpError, void> =>
    fromPromiseAbortable<HttpError, void>(
        (signal) =>
            new Promise<void>((resolve, reject) => {
                const id = setTimeout(resolve, ms);

                const onAbort = () => {
                    clearTimeout(id);
                    // forzamos un AbortError “standard-ish”
                    const err =
                        typeof (globalThis as any).DOMException === "function"
                            ? new (globalThis as any).DOMException("Aborted", "AbortError")
                            : ({ name: "AbortError" } as any);
                    reject(err);
                };

                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
            }),
        normalizeHttpError
    );

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

export const withRetry =
    (p: RetryPolicy) =>
        (next: HttpClient): HttpClient => {
            const retryOnMethods = p.retryOnMethods ?? defaultRetryableMethods;
            const retryOnStatus = p.retryOnStatus ?? defaultRetryOnStatus;
            const retryOnError = p.retryOnError ?? defaultRetryOnError;

            const isMethodRetryable = (req: HttpRequest) => retryOnMethods.includes(req.method);

            const loop = (req: HttpRequest, attempt: number): Async<unknown, HttpError, HttpWireResponse> => {
                if (!isMethodRetryable(req)) return next(req);

                return asyncFold(
                    next(req),

                    // onFailure
                    (e) => {
                        if (e._tag === "Abort" || e._tag === "BadUrl") return asyncFail(e);

                        const canRetry = attempt < p.maxRetries && retryOnError(e);
                        if (!canRetry) return asyncFail(e);

                        const d = backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs);
                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1));
                    },

                    // onSuccess
                    (w) => {
                        const canRetry = attempt < p.maxRetries && retryOnStatus(w.status);
                        if (!canRetry) return asyncSucceed(w);

                        const ra = retryAfterMs(w.headers);
                        const d = ra ?? backoffDelayMs(attempt, p.baseDelayMs, p.maxDelayMs);

                        return asyncFlatMap(sleepMs(d), () => loop(req, attempt + 1));
                    }
                );
            };

            return (req) => loop(req, 0);
        };
