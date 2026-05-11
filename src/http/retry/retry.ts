import type {
    HttpClientFn,
    HttpError,
    HttpMethod,
    HttpMiddleware,
    HttpRequest,
    HttpWireResponse
} from "../client";
import { async as asyncRegister, asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import { makeScheduleDriver, type Schedule, type ScheduleDriver, type ScheduleObserver } from "../../core/runtime/schedule";
import { makeWasmRetryPlanner } from "./wasmRetryPlanner";

/**
 * Observable event emitted on each retry attempt via the `onRetry` callback.
 */
export type RetryEvent = {
    /** Zero-based attempt number (0 = first retry, not the initial request). */
    attempt: number;
    /** Computed delay in milliseconds before the next attempt. */
    delayMs: number;
    /** The error that triggered this retry, if the request failed with an HttpError. */
    error?: HttpError;
    /** The HTTP status code that triggered this retry, if the request returned a retryable status. */
    status?: number;
    /** The request URL. */
    url: string;
    /** The request HTTP method. */
    method: HttpMethod;
    /** Timestamp (ms since epoch) when the retry decision was made. */
    timestamp: number;
};

export type RetryScheduleInput = {
    readonly attempt: number;
    readonly elapsedMs: number;
    readonly request: HttpRequest;
    readonly error?: HttpError;
    readonly status?: number;
    readonly retryAfterMs?: number;
};

/**
 * Per-request retry override. Attached as `(req as any).retry`.
 * - `false` disables retry entirely for this request.
 * - A partial policy object merges with the middleware-level policy (per-request wins).
 */
export type PerRequestRetryOverride =
    | false
    | {
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
        schedule?: Schedule<RetryScheduleInput, unknown>;
        retryOnStatus?: (status: number) => boolean;
    };

export type RetryPolicy = {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /** Optional declarative schedule. When present, it provides retry delays. */
    schedule?: Schedule<RetryScheduleInput, unknown>;
    /** Optional observer for declarative schedule decisions. */
    onScheduleDecision?: ScheduleObserver<RetryScheduleInput, unknown>;

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

    /** Called synchronously before each retry delay begins. Zero overhead when omitted. */
    onRetry?: (event: RetryEvent) => void;
};

export const defaultRetryableMethods: HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

export const defaultRetryOnStatus = (s: number) =>
    s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

export const defaultRetryOnError = (e: HttpError) =>
    e._tag === "FetchError" || e._tag === "Timeout" || e._tag === "PoolTimeout";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// “full jitter”: random(0, cap)
export const backoffDelayMs = (attempt: number, base: number, cap: number) => {
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
export const retryAfterMs = (headers: Record<string, string>): number | undefined => {
    const v = headerCI(headers, "retry-after")?.trim();
    if (!v) return undefined;

    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.max(0, Math.floor(secs * 1000));

    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());

    return undefined;
};

export const normalizeRetryBudget = (ms: number | undefined): number | undefined => {
    if (ms === undefined || !Number.isFinite(ms)) return undefined;
    return Math.max(0, Math.floor(ms));
};

const resolveEffectivePolicy = (req: HttpRequest, basePolicy: RetryPolicy): RetryPolicy | null => {
    const override = (req as any).retry as PerRequestRetryOverride | undefined;
    if (override === false) return null; // null signals "skip retry"
    if (override === undefined) return basePolicy;
    return {
        ...basePolicy,
        ...(override.maxRetries !== undefined && { maxRetries: override.maxRetries }),
        ...(override.baseDelayMs !== undefined && { baseDelayMs: override.baseDelayMs }),
        ...(override.maxDelayMs !== undefined && { maxDelayMs: override.maxDelayMs }),
        ...(override.schedule !== undefined && { schedule: override.schedule }),
        ...(override.retryOnStatus !== undefined && { retryOnStatus: override.retryOnStatus }),
    };
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
            const retryEngine = resolveRetryEngine(p);
            const wasmPlanner = retryEngine === "wasm" ? makeWasmRetryPlanner() : undefined;

            const isMethodRetryable = (req: HttpRequest) => retryOnMethods.includes(req.method);

            const nextDelay = (
                ep: RetryPolicy,
                epMaxElapsedMs: number | undefined,
                retryId: number | undefined,
                attempt: number,
                startedAt: number,
                retryable: boolean,
                scheduleDriver: ScheduleDriver<RetryScheduleInput, unknown> | undefined,
                input: RetryScheduleInput,
            ): { delayMs: number } | undefined => {
                if (!retryable) return undefined;
                const remainingBudget = epMaxElapsedMs === undefined ? Number.POSITIVE_INFINITY : epMaxElapsedMs - (performance.now() - startedAt);
                if (remainingBudget <= 0) return undefined;
                if (scheduleDriver) {
                    const decision = scheduleDriver.next(input);
                    if (!decision.continue) return undefined;
                    const rawDelay = input.retryAfterMs === undefined
                        ? decision.delayMs
                        : Math.min(input.retryAfterMs, ep.maxDelayMs);
                    return {
                        delayMs: Math.max(0, Math.min(rawDelay, remainingBudget)),
                    };
                }
                if (wasmPlanner && retryId !== undefined) {
                    const delay = wasmPlanner.nextDelayMs(retryId, {
                        nowMs: performance.now(),
                        retryable,
                        retryAfterMs: input.retryAfterMs,
                    });
                    return delay === undefined ? undefined : { delayMs: delay };
                }
                const rawDelay = input.retryAfterMs === undefined
                    ? backoffDelayMs(attempt, ep.baseDelayMs, ep.maxDelayMs)
                    : Math.min(input.retryAfterMs, ep.maxDelayMs);
                return { delayMs: Math.max(0, Math.min(rawDelay, remainingBudget)) };
            };

            const sleepWithCleanup = (ms: number, onCancel: () => void): Async<unknown, never, void> => {
                return asyncRegister((_env: unknown, cb: (exit: any) => void) => {
                    const delay = Math.max(0, Math.floor(ms));
                    const id = setTimeout(() => cb({ _tag: "Success", value: undefined }), delay);
                    return () => {
                        clearTimeout(id);
                        onCancel();
                    };
                });
            };

            const loop = (req: HttpRequest, attempt: number, startedAt: number, retryId: number | undefined, ep: RetryPolicy, epMaxElapsedMs: number | undefined, epRetryOnStatus: (s: number) => boolean, epRetryOnError: (e: HttpError) => boolean, originalPriority: number, safeDrop: (id: number | undefined) => void, scheduleDriver: ScheduleDriver<RetryScheduleInput, unknown> | undefined): Async<unknown, HttpError, HttpWireResponse> => {
                if (!isMethodRetryable(req)) return next(req);

                // Boost priority for retry attempts (attempt > 0)
                const effectiveReq = attempt > 0
                    ? (() => { const boostedReq = { ...req }; (boostedReq as any).priority = Math.max(0, originalPriority - 1); return boostedReq as HttpRequest; })()
                    : req;

                const remainingBudget = () =>
                    epMaxElapsedMs === undefined ? Number.POSITIVE_INFINITY : epMaxElapsedMs - (performance.now() - startedAt);

                return asyncFold(
                    next(effectiveReq),
                    (e) => {
                        if (e._tag === "Abort" || e._tag === "BadUrl" || e._tag === "PoolRejected" || e._tag === "PoolClosed" || (e as any)._tag === "CircuitBreakerOpen") {
                            safeDrop(retryId);
                            return asyncFail(e);
                        }

                        const retryable = attempt < ep.maxRetries && epRetryOnError(e) && remainingBudget() > 0;
                        const retryDecision = nextDelay(ep, epMaxElapsedMs, retryId, attempt, startedAt, retryable, scheduleDriver, {
                            attempt,
                            elapsedMs: performance.now() - startedAt,
                            request: req,
                            error: e,
                        });
                        if (retryDecision === undefined || (retryDecision.delayMs <= 0 && epMaxElapsedMs !== undefined)) {
                            safeDrop(retryId);
                            return asyncFail(e);
                        }
                        if (ep.onRetry) {
                            ep.onRetry({
                                attempt,
                                delayMs: retryDecision.delayMs,
                                error: e,
                                status: undefined,
                                url: req.url,
                                method: req.method,
                                timestamp: Date.now(),
                            });
                        }
                        return asyncFlatMap(sleepWithCleanup(retryDecision.delayMs, () => safeDrop(retryId)) as any, () => loop(req, attempt + 1, startedAt, retryId, ep, epMaxElapsedMs, epRetryOnStatus, epRetryOnError, originalPriority, safeDrop, scheduleDriver));
                    },
                    (w) => {
                        const retryable = attempt < ep.maxRetries && epRetryOnStatus(w.status) && remainingBudget() > 0;
                        const ra = ep.respectRetryAfter === false ? undefined : retryAfterMs(w.headers);
                        const retryDecision = nextDelay(ep, epMaxElapsedMs, retryId, attempt, startedAt, retryable, scheduleDriver, {
                            attempt,
                            elapsedMs: performance.now() - startedAt,
                            request: req,
                            status: w.status,
                            retryAfterMs: ra,
                        });
                        if (retryDecision === undefined || (retryDecision.delayMs <= 0 && epMaxElapsedMs !== undefined)) {
                            safeDrop(retryId);
                            return asyncSucceed(w);
                        }
                        if (ep.onRetry) {
                            ep.onRetry({
                                attempt,
                                delayMs: retryDecision.delayMs,
                                error: undefined,
                                status: w.status,
                                url: req.url,
                                method: req.method,
                                timestamp: Date.now(),
                            });
                        }
                        return asyncFlatMap(sleepWithCleanup(retryDecision.delayMs, () => safeDrop(retryId)) as any, () => loop(req, attempt + 1, startedAt, retryId, ep, epMaxElapsedMs, epRetryOnStatus, epRetryOnError, originalPriority, safeDrop, scheduleDriver));
                    }
                );
            };

            return (req) => {
                const effectivePolicy = resolveEffectivePolicy(req, p);
                if (effectivePolicy === null) return next(req);

                if (!isMethodRetryable(req)) return next(req);

                const epRetryOnStatus = effectivePolicy.retryOnStatus ?? defaultRetryOnStatus;
                const epRetryOnError = effectivePolicy.retryOnError ?? defaultRetryOnError;
                const epMaxElapsedMs = normalizeRetryBudget(effectivePolicy.maxElapsedMs);
                const originalPriority = (req as any).priority ?? 5;

                const startedAt = performance.now();
                const retryId = wasmPlanner?.start({
                    nowMs: startedAt,
                    maxRetries: effectivePolicy.maxRetries,
                    baseDelayMs: effectivePolicy.baseDelayMs,
                    maxDelayMs: effectivePolicy.maxDelayMs,
                    maxElapsedMs: epMaxElapsedMs,
                });

                // Track whether planner was already dropped (per-request scope)
                let plannerDropped = false;
                const safeDrop = (id: number | undefined) => {
                    if (id !== undefined && !plannerDropped) {
                        plannerDropped = true;
                        wasmPlanner?.drop(id);
                    }
                };

                const scheduleDriver = effectivePolicy.schedule
                    ? makeScheduleDriver(effectivePolicy.schedule, {
                        name: effectivePolicy.schedule.name ?? "http.retry",
                        startedAtMs: startedAt,
                        onDecision: effectivePolicy.onScheduleDecision,
                    })
                    : undefined;
                return loop(req, 0, startedAt, retryId, effectivePolicy, epMaxElapsedMs, epRetryOnStatus, epRetryOnError, originalPriority, safeDrop, scheduleDriver);
            };
        };
