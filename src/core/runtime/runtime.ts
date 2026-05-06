import { async, Async } from "../types/asyncEffect";
import { globalScheduler, inferCallerLaneFromStack, Scheduler } from "./scheduler";
import { Fiber, getCurrentFiber } from "./fiber";
import { Cause, Exit } from "../types/effect";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "./events";
import { makeForkPolicy } from "./forkPolicy";
import { RuntimeRegistry } from "./registry";
import { DefaultHostExecutor, type HostExecutor } from "./hostAction";
import { JsFiberEngine } from "./engine/JsFiberEngine";
import { WasmFiberEngine, type WasmFiberEngineOptions } from "./engine/WasmFiberEngine";
import type { FiberEngine, RuntimeEngineMode } from "./engine/types";
import type { EngineStats } from "./engineStats";
import { runtimeCapabilities } from "./capabilities";

// fallback hooks (no-op)
export const NoopHooks: RuntimeHooks = {
    emit() { },
};

function normalizeRuntimeEngineMode(value: unknown): RuntimeEngineMode {
    if (value === "ts" || value === "wasm") return value;
    throw new Error(`brass-runtime engine must be either 'ts' or 'wasm' in strict mode; received '${String(value)}'`);
}

function unreachableEngine(value: never): never {
    throw new Error(`brass-runtime unsupported engine '${String(value)}'`);
}

/**
 * --- Runtime como objeto único (ZIO-style) ---
 * Un valor que representa "cómo" se ejecutan los efectos: scheduler + environment + hooks.
 */
export type RuntimeOptions<R> = {
    env: R;
    scheduler?: Scheduler;
    /** Logical caller/lane. When set, every fiber forked by this runtime is scheduled inside this lane. */
    lane?: string;
    /** Infer a caller lane from the top-level callsite when no explicit lane/parent lane exists. Defaults to true. */
    inferLane?: boolean;
    hooks?: RuntimeHooks;
    /**
     * Selects the fiber interpreter used by fork().
     *
     * Strict mode only accepts:
     * - ts: TypeScript RuntimeFiber interpreter.
     * - wasm: wasm-pack backed interpreter from wasm/pkg.
     *
     * There is no auto mode and no TS fallback when wasm is requested.
     */
    engine?: RuntimeEngineMode;
    /** Executor used by HostAction opcodes when running on the WASM engine. */
    hostExecutor?: HostExecutor<R>;
    /** Optional low-level WASM bridge options, mostly for tests and local experiments. */
    wasm?: WasmFiberEngineOptions;
};

export class Runtime<R> {
    readonly env: R;
    readonly scheduler: Scheduler;
    readonly hooks: RuntimeHooks;
    readonly hostExecutor: HostExecutor<R>;
    readonly engineMode: RuntimeEngineMode;
    readonly wasmOptions?: WasmFiberEngineOptions;
    readonly fiberEngine: FiberEngine<R>;
    readonly fallbackUsed: boolean;
    readonly forkPolicy;
    readonly lane?: string;
    readonly inferLane: boolean;

    // opcional: registry para observabilidad
    registry?: RuntimeRegistry;

    constructor(args: RuntimeOptions<R>) {
        this.env = args.env;
        this.scheduler = args.scheduler ?? globalScheduler;
        this.lane = args.lane;
        this.inferLane = args.inferLane ?? true;
        this.hooks = args.hooks ?? NoopHooks;
        this.hostExecutor = args.hostExecutor ?? DefaultHostExecutor;
        this.engineMode = normalizeRuntimeEngineMode(args.engine ?? "ts");
        this.wasmOptions = args.wasm;
        this.forkPolicy = makeForkPolicy(this.env as any, this.hooks);
        this.fiberEngine = this.makeFiberEngine(this.engineMode, args.wasm);
        this.fallbackUsed = false;
    }

    private makeFiberEngine(mode: RuntimeEngineMode, wasm?: WasmFiberEngineOptions): FiberEngine<R> {
        if (mode === "ts") return new JsFiberEngine(this as any);
        if (mode === "wasm") return new WasmFiberEngine(this as any, wasm);
        return unreachableEngine(mode);
    }

    /** Returns true when the runtime has real hooks (not the no-op singleton). */
    hasActiveHooks(): boolean {
        return this.hooks !== NoopHooks;
    }

    /** Deriva un runtime con env extendido (estilo provide/locally) */
    provide<R2>(env: R2): Runtime<R & R2> {
        return new Runtime({
            env: Object.assign({}, this.env, env) as any,
            scheduler: this.scheduler,
            hooks: this.hooks,
            engine: this.engineMode,
            hostExecutor: this.hostExecutor as any,
            wasm: this.wasmOptions,
            lane: this.lane,
            inferLane: this.inferLane,
        });
    }

    /**
     * Returns a derived runtime that schedules all work in a caller/lane.
     * Brass does not need to know the caller implementation; it only sees this stable key.
     */
    withLane(lane: string): Runtime<R> {
        return new Runtime({
            env: this.env,
            scheduler: this.scheduler,
            hooks: this.hooks,
            engine: this.engineMode,
            hostExecutor: this.hostExecutor,
            wasm: this.wasmOptions,
            lane,
            inferLane: this.inferLane,
        });
    }

    private resolveFiberLane(parent: unknown): string | undefined {
        if (this.lane !== undefined) return this.lane;
        const parentLane = (parent as any)?.lane;
        if (typeof parentLane === "string" && parentLane.length > 0) return parentLane;
        if (!this.inferLane) return undefined;
        return inferCallerLaneFromStack(undefined, "runtime");
    }

    emit(ev: RuntimeEvent) {
        // Fast-path: skip entirely when no hooks are active (NoopHooks singleton)
        if (this.hooks === NoopHooks) return;

        const f = getCurrentFiber() as any;

        const ctx: RuntimeEmitContext = {
            fiberId: f?.id,
            scopeId: f?.scopeId, // ✅ FIX: era f?.scope
            traceId: f?.fiberContext?.trace?.traceId,
            spanId: f?.fiberContext?.trace?.spanId,
        };

        this.hooks.emit(ev, ctx);
    }

    /**
     * ✅ CAMBIO: fork(effect, scopeId?) y pasa scopeId a forkPolicy
     */
    fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A> {
        const parent = getCurrentFiber();
        const fiber = this.fiberEngine.fork(effect, scopeId) as any;
        const lane = this.resolveFiberLane(parent);
        if (lane !== undefined) fiber.lane = lane;

        // Si el caller provee scopeId (p.ej. Scope.fork), lo seteamos antes de initChild
        if (scopeId !== undefined) fiber.scopeId = scopeId;

        this.forkPolicy.initChild(fiber, parent as any, scopeId);
        fiber.schedule?.("initial-step");
        return fiber;
    }

    stats(): EngineStats<ReturnType<FiberEngine<R>["stats"]>> {
        const data = this.fiberEngine.stats();
        return { engine: this.fiberEngine.kind, fallbackUsed: false, data };
    }

    capabilities() {
        return runtimeCapabilities();
    }

    shutdown(): Promise<void> | void {
        return this.fiberEngine.shutdown?.();
    }

    unsafeRunAsync<E, A>(
        effect: Async<R, E, A>,
        cb: (exit: Exit<E, A>) => void
    ): void {
        const fiber = this.fork(effect);
        fiber.join(cb);
    }

    toPromise<E, A>(effect: Async<R, E, A>): Promise<A> {
        return new Promise((resolve, reject) => {
            const fiber = this.fork(effect);
            fiber.join((exit) => {
                if (exit._tag === "Success") resolve(exit.value);
                else {
                    const c: any = (exit as any).cause;
                    if (c?._tag === "Fail") reject(c.error);
                    else if (c?._tag === "Die") reject(c.defect instanceof Error ? c.defect : new Error(String(c.defect)));
                    else reject(new Error("Interrupted"));
                }
            });
        });
    }

    // helper: correr un efecto y “tirar” el resultado
    unsafeRun<E, A>(effect: Async<R, E, A>): void {
        this.unsafeRunAsync(effect, () => { });
    }

    delay<E, A>(ms: number, eff: Async<R, E, A>): Async<R, E, A> {
        return async((_env, cb) => {
            const handle = setTimeout(() => {
                this.unsafeRunAsync(eff, cb);
            }, ms);

            // Canceler
            return () => clearTimeout(handle);
        });
    }

    // util para crear runtime default
    static make<R>(env: R, scheduler: Scheduler = globalScheduler): Runtime<R> {
        return new Runtime({ env, scheduler });
    }

    static makeWithEngine<R>(
        env: R,
        engine: RuntimeEngineMode,
        options: Omit<RuntimeOptions<R>, "env" | "engine"> = {}
    ): Runtime<R> {
        return new Runtime({ ...options, env, engine });
    }

    /** Convenience logger: emits a RuntimeEvent of type "log". */
    log(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
        this.emit({ type: "log", level, message, fields });
    }
}

// -----------------------------------------------------------------------------
// Top-level helpers (used by examples)
// -----------------------------------------------------------------------------

/** Create a runtime from `env` and fork the given effect. */
export function fork<R, E, A>(effect: Async<R, E, A>, env?: R): Fiber<E, A> {
    return Runtime.make((env ?? ({} as any)) as R).fork(effect);
}

/** Create a runtime with a stable lane/caller key. */
export function runtimeForCaller<R>(caller: string, env?: R): Runtime<R> {
    return Runtime.make((env ?? ({} as any)) as R).withLane(caller);
}

/** Run an effect in a caller lane without exposing scheduler internals to the caller. */
export function toPromiseByCaller<R, E, A>(caller: string, effect: Async<R, E, A>, env?: R): Promise<A> {
    return runtimeForCaller(caller, env).toPromise(effect);
}

/** Run an effect with `env` and invoke `cb` with the final Exit. */
export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R | undefined,
    cb: (exit: Exit<E, A>) => void
): void {
    Runtime.make((env ?? ({} as any)) as R).unsafeRunAsync(effect, cb);
}

/** Run an effect with `env` and return a Promise of its success value. */
export function toPromise<R, E, A>(effect: Async<R, E, A>, env?: R): Promise<A> {
    return Runtime.make((env ?? ({} as any)) as R).toPromise(effect);
}


export type AbortablePromiseOutcome = "success" | "failure" | "interrupt" | "timeout";

export type AbortablePromiseFinish = {
    readonly label: string;
    readonly outcome: AbortablePromiseOutcome;
    readonly durationMs: number;
    readonly error?: unknown;
};

export type AbortablePromiseOptions = {
    /** Logical label used by diagnostics. Keep it low-cardinality: e.g. `http:GET:https://api.foo.com`. */
    readonly label?: string;
    /** Fails the effect after this budget and aborts the underlying signal. Disabled when omitted or <= 0. */
    readonly timeoutMs?: number;
    /** Custom reason passed to `onReject` when the timeout fires. */
    readonly timeoutReason?: () => unknown;
    readonly onStart?: (label: string) => void;
    readonly onFinish?: (finish: AbortablePromiseFinish) => void;
};

export type AbortablePromiseLabelStats = {
    readonly label: string;
    readonly active: number;
    readonly started: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly timedOut: number;
    readonly lateSettlements: number;
};

export type AbortablePromiseStats = {
    readonly active: number;
    readonly started: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly timedOut: number;
    readonly lateSettlements: number;
    readonly byLabel: AbortablePromiseLabelStats[];
};

type MutableAbortablePromiseLabelStats = {
    label: string;
    active: number;
    started: number;
    succeeded: number;
    failed: number;
    interrupted: number;
    timedOut: number;
    lateSettlements: number;
};

const abortablePromiseTotals: Omit<MutableAbortablePromiseLabelStats, "label"> = {
    active: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    timedOut: 0,
    lateSettlements: 0,
};
const abortablePromiseLabels = new Map<string, MutableAbortablePromiseLabelStats>();

const getAbortablePromiseLabelStats = (label: string): MutableAbortablePromiseLabelStats => {
    const existing = abortablePromiseLabels.get(label);
    if (existing) return existing;
    const created: MutableAbortablePromiseLabelStats = {
        label,
        active: 0,
        started: 0,
        succeeded: 0,
        failed: 0,
        interrupted: 0,
        timedOut: 0,
        lateSettlements: 0,
    };
    abortablePromiseLabels.set(label, created);
    return created;
};

const recordAbortablePromiseStart = (label: string): void => {
    const byLabel = getAbortablePromiseLabelStats(label);
    abortablePromiseTotals.active++;
    abortablePromiseTotals.started++;
    byLabel.active++;
    byLabel.started++;
};

const recordAbortablePromiseFinish = (label: string, outcome: AbortablePromiseOutcome): void => {
    const byLabel = getAbortablePromiseLabelStats(label);
    if (abortablePromiseTotals.active > 0) abortablePromiseTotals.active--;
    if (byLabel.active > 0) byLabel.active--;
    switch (outcome) {
        case "success":
            abortablePromiseTotals.succeeded++;
            byLabel.succeeded++;
            return;
        case "failure":
            abortablePromiseTotals.failed++;
            byLabel.failed++;
            return;
        case "interrupt":
            abortablePromiseTotals.interrupted++;
            byLabel.interrupted++;
            return;
        case "timeout":
            abortablePromiseTotals.timedOut++;
            byLabel.timedOut++;
            return;
    }
};

const recordAbortablePromiseLateSettlement = (label: string): void => {
    const byLabel = getAbortablePromiseLabelStats(label);
    abortablePromiseTotals.lateSettlements++;
    byLabel.lateSettlements++;
};

export function abortablePromiseStats(): AbortablePromiseStats {
    return {
        ...abortablePromiseTotals,
        byLabel: Array.from(abortablePromiseLabels.values())
            .map((x) => ({ ...x }))
            .sort((a, b) => b.active - a.active || b.started - a.started || a.label.localeCompare(b.label)),
    };
}

export function resetAbortablePromiseStats(): void {
    abortablePromiseTotals.active = 0;
    abortablePromiseTotals.started = 0;
    abortablePromiseTotals.succeeded = 0;
    abortablePromiseTotals.failed = 0;
    abortablePromiseTotals.interrupted = 0;
    abortablePromiseTotals.timedOut = 0;
    abortablePromiseTotals.lateSettlements = 0;
    abortablePromiseLabels.clear();
}

const normalizeAbortablePromiseLabel = (label: string | undefined): string => {
    const value = label?.trim();
    return value && value.length > 0 ? value.slice(0, 160) : "anonymous";
};

const makeTimeoutReason = (timeoutMs: number, label: string): unknown => ({
    _tag: "Timeout",
    timeoutMs,
    message: `Abortable promise '${label}' timed out after ${timeoutMs}ms`,
});

/**
 * Create an Async from an abortable Promise.
 *
 * Improvements over the original helper:
 * - optional timeout budget;
 * - global active/late-settlement diagnostics;
 * - explicit start/finish hooks for transport metrics;
 * - cleanup on every completion path, so timers/listeners do not retain fibers.
 *
 * Type params are ordered as `<E, A, R = unknown>` to match call-sites.
 */
export function fromPromiseAbortable<E, A, R = unknown>(
    make: (signal: AbortSignal, env: R) => Promise<A>,
    onReject: (u: unknown) => E,
    options: AbortablePromiseOptions = {}
): Async<R, E, A> {
    return {
        _tag: "Async",
        register: (env: R, cb: (exit: Exit<E, A>) => void) => {
            const controller = new AbortController();
            const label = normalizeAbortablePromiseLabel(options.label);
            const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
                ? Math.max(0, Math.floor(options.timeoutMs))
                : undefined;
            const startedAt = performance.now();
            let done = false;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
            };

            const finish = (outcome: AbortablePromiseOutcome, exit: Exit<E, A>, error?: unknown) => {
                if (done) return;
                done = true;
                cleanup();
                recordAbortablePromiseFinish(label, outcome);
                options.onFinish?.({
                    label,
                    outcome,
                    durationMs: Math.round(performance.now() - startedAt),
                    error,
                });
                cb(exit);
            };

            recordAbortablePromiseStart(label);
            options.onStart?.(label);

            if (timeoutMs !== undefined && timeoutMs > 0) {
                timeoutHandle = setTimeout(() => {
                    const reason = options.timeoutReason?.() ?? makeTimeoutReason(timeoutMs, label);
                    try {
                        controller.abort(reason);
                    } catch {
                        controller.abort();
                    }
                    finish("timeout", Exit.failCause(Cause.fail(onReject(reason))), reason);
                }, timeoutMs);
            }

            let promise: Promise<A>;
            try {
                promise = make(controller.signal, env);
            } catch (err) {
                finish("failure", Exit.failCause(Cause.fail(onReject(err))), err);
                return () => undefined;
            }

            promise
                .then((value) => {
                    if (done) {
                        recordAbortablePromiseLateSettlement(label);
                        return;
                    }
                    finish("success", Exit.succeed(value));
                })
                .catch((err) => {
                    if (done) {
                        recordAbortablePromiseLateSettlement(label);
                        return;
                    }
                    finish("failure", Exit.failCause(Cause.fail(onReject(err))), err);
                });

            return () => {
                if (done) return;
                try {
                    controller.abort();
                } catch {
                    // ignore
                }
                finish("interrupt", Exit.failCause(Cause.interrupt()));
            };
        },
    };
}


export function unsafeRunFoldWithEnv<R, E, A>(
  eff: Async<R, E, A>,
  env: R,
  onFailure: (cause: Cause<E>) => void,
  onSuccess: (value: A) => void
): void {
  unsafeRunAsync(eff, env, (ex: any) => {
    if (ex._tag === "Failure") onFailure(ex.cause);
    else onSuccess(ex.value);
  });
}