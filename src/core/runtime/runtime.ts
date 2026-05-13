import { async, Async } from "../types/asyncEffect";
import { globalScheduler, inferCallerLaneFromStack, Scheduler } from "./scheduler";
import { Fiber, getCurrentFiber, withCurrentFiber } from "./fiber";
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
import { Schema, parseConfig } from "../../schema";
import { runtimeClockFromEnv } from "./clock";

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

const runtimeOptionsSchema = Schema.object({
    env: Schema.any(),
    lane: Schema.string({ minLength: 1 }).optional(),
    inferLane: Schema.boolean().optional(),
    engine: Schema.enum(["ts", "wasm"] as const).optional(),
}, { unknownKeys: "passthrough" });

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
        parseConfig("RuntimeOptions", runtimeOptionsSchema, args);

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
            parentSpanId: f?.fiberContext?.trace?.parentSpanId,
            traceState: f?.fiberContext?.trace?.traceState,
            baggage: f?.fiberContext?.trace?.baggage,
            sampled: f?.fiberContext?.trace?.sampled,
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
        if (this.tryRunNativeTopLevel(effect, cb)) return;

        const fiber = this.fork(effect);
        fiber.join(cb);
    }

    toPromise<E, A>(effect: Async<R, E, A>): Promise<A> {
        return new Promise((resolve, reject) => {
            const complete = (exit: Exit<E, A>) => {
                if (exit._tag === "Success") {
                    resolve(exit.value);
                    return;
                }
                const failure = Cause.firstFailure(exit.cause);
                if (failure._tag === "Some") reject(failure.value);
                else {
                    const defect = Cause.firstDefect(exit.cause);
                    if (defect._tag === "Some") {
                        reject(defect.value instanceof Error ? defect.value : new Error(String(defect.value)));
                    } else if (Cause.containsInterrupt(exit.cause)) {
                        reject(new Error("Interrupted"));
                    } else {
                        reject(Cause.toError(exit.cause));
                    }
                }
            };
            if (this.tryRunNativeTopLevel(effect, complete)) return;

            const fiber = this.fork(effect);
            fiber.join((exit) => {
                complete(exit);
            });
        });
    }

    private tryRunNativeTopLevel<E, A>(effect: Async<R, E, A>, cb: (exit: Exit<E, A>) => void): boolean {
        if (this.hooks !== NoopHooks) return false;
        if (getCurrentFiber() !== null) return false;
        if (this.scheduler !== globalScheduler) return false;
        if (this.inferLane) return false;
        if (this.engineMode !== "ts") return false;
        new NativeTopLevelRunner(this, effect, cb).start();
        return true;
    }

    // helper: correr un efecto y “tirar” el resultado
    unsafeRun<E, A>(effect: Async<R, E, A>): void {
        this.unsafeRunAsync(effect, () => { });
    }

    delay<E, A>(ms: number, eff: Async<R, E, A>): Async<R, E, A> {
        return async((_env, cb) => {
            const clock = runtimeClockFromEnv(this.env);
            const handle = clock.setTimeout(() => {
                this.unsafeRunAsync(eff, cb);
            }, ms);

            // Canceler
            return () => clock.clearTimeout(handle);
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

type NativeContinuation<R, E> =
    | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
    | {
        _tag: "FoldCont";
        onFailure: (e: any) => Async<R, E, any>;
        onSuccess: (a: any) => Async<R, E, any>;
    }
    | { _tag: "InterruptibilityCont" }
    | { _tag: "FiberRefCont"; refId: number; hadValue: boolean; previousValue: unknown };

const NATIVE_FAST_PATH_STEP_BUDGET = 32768;

class NativeTopLevelRunner<R, E, A> {
    private current: Async<R, E, any>;
    private readonly stack: NativeContinuation<R, E>[] = [];
    private readonly joiners: Array<(exit: Exit<E, A>) => void> = [];
    private readonly finalizers: Array<(exit: Exit<E, A>) => void | Async<any, any, any>> = [];
    private result: Exit<E, A> | undefined;
    private yielded = false;

    private readonly frame: any;

    constructor(
        private readonly runtime: Runtime<R>,
        effect: Async<R, E, A>,
        cb: (exit: Exit<E, A>) => void,
    ) {
        this.current = effect;
        this.joiners.push(cb);
        this.frame = {
            id: 0,
            runtime,
            name: "native-fast-path",
            fiberContext: { trace: null },
            lane: runtime.lane,
            status: () => this.result ? "Done" : "Running",
            join: (joiner: (exit: Exit<E, A>) => void) => {
                if (this.result) joiner(this.result);
                else this.joiners.push(joiner);
            },
            interrupt: () => undefined,
            addFinalizer: (finalizer: (exit: Exit<E, A>) => void | Async<any, any, any>) => {
                this.finalizers.push(finalizer);
            },
        };
    }

    start(): void {
        this.runLoop();
    }

    private runLoop(): void {
        this.withFrame(() => {
            this.yielded = false;
            let budget = NATIVE_FAST_PATH_STEP_BUDGET;

            while (!this.result && budget-- > 0) {
                const current: any = this.current;

                switch (current._tag) {
                    case "Succeed":
                        this.onSuccess(current.value);
                        break;

                    case "Fail":
                        this.onCause(Cause.fail(current.error as E));
                        break;

                    case "Sync":
                        try {
                            this.onSuccess(current.thunk(this.runtime.env));
                        } catch (error) {
                            this.onCause(Cause.fail(error as E));
                        }
                        break;

                    case "FlatMap":
                        this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                        this.current = current.first;
                        break;

                    case "Fold":
                        this.stack.push({
                            _tag: "FoldCont",
                            onFailure: current.onFailure,
                            onSuccess: current.onSuccess,
                        });
                        this.current = current.first;
                        break;

                    case "Async":
                        if (this.runAsync(current)) break;
                        return;

                    case "Fork":
                        this.onSuccess(this.runtime.fork(current.effect, current.scopeId) as any);
                        break;

                    case "Interruptibility":
                        this.stack.push({ _tag: "InterruptibilityCont" });
                        this.current = current.effect;
                        break;

                    case "InterruptibilityMask":
                        this.stack.push({ _tag: "InterruptibilityCont" });
                        try {
                            this.current = current.body((effect: Async<any, any, any>) => ({
                                _tag: "InterruptibilityRestore",
                                depth: 0,
                                effect,
                            }));
                        } catch (error) {
                            this.onCause(Cause.die<E>(error));
                        }
                        break;

                    case "InterruptibilityRestore":
                        this.stack.push({ _tag: "InterruptibilityCont" });
                        this.current = current.effect;
                        break;

                    case "FiberRefLocally": {
                        const refs = this.fiberRefs();
                        const hadValue = refs.has(current.refId);
                        const previousValue = refs.get(current.refId);
                        refs.set(current.refId, current.value);
                        this.stack.push({
                            _tag: "FiberRefCont",
                            refId: current.refId,
                            hadValue,
                            previousValue,
                        });
                        this.current = current.effect;
                        break;
                    }

                    default:
                        this.onCause(Cause.fail(new Error(`Unknown opcode: ${current._tag}`) as E));
                        break;
                }
            }

            if (!this.result && !this.yielded) {
                this.yielded = true;
                queueMicrotask(() => this.runLoop());
            }
        });
    }

    private runAsync(current: { register: (env: R, cb: (exit: Exit<E, any>) => void) => void | (() => void) }): boolean {
        let registered = false;
        let settled = false;
        let syncExit: Exit<E, any> | undefined;

        const resume = (exit: Exit<E, any>) => {
            if (settled) return;
            settled = true;
            if (!registered) {
                syncExit = exit;
                return;
            }
            queueMicrotask(() => this.resumeAsync(exit));
        };

        try {
            current.register(this.runtime.env, resume);
        } catch (error) {
            this.onCause(Cause.die<E>(error));
            return true;
        }

        registered = true;
        if (syncExit) {
            this.consumeExit(syncExit);
            return true;
        }
        return false;
    }

    private resumeAsync(exit: Exit<E, any>): void {
        if (this.result) return;
        this.withFrame(() => this.consumeExit(exit));
        if (!this.result) this.runLoop();
    }

    private consumeExit(exit: Exit<E, any>): void {
        if (exit._tag === "Success") this.onSuccess(exit.value);
        else this.onCause(exit.cause);
    }

    private onSuccess(value: any): void {
        let currentValue = value;
        while (true) {
            const frame = this.stack.pop();
            if (!frame) {
                this.notify(Exit.succeed(currentValue));
                return;
            }

            if (frame._tag === "InterruptibilityCont") continue;

            if (frame._tag === "FiberRefCont") {
                this.restoreFiberRef(frame);
                continue;
            }

            if (frame._tag === "SuccessCont") {
                try {
                    this.current = frame.k(currentValue);
                } catch (error) {
                    this.notify(Exit.failCause(Cause.die<E>(error)));
                }
                return;
            }

            try {
                this.current = frame.onSuccess(currentValue);
            } catch (error) {
                this.notify(Exit.failCause(Cause.die<E>(error)));
            }
            return;
        }
    }

    private onCause(cause: Cause<E>): void {
        let currentCause = cause;

        while (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (frame._tag === "InterruptibilityCont") continue;

            if (frame._tag === "FiberRefCont") {
                this.restoreFiberRef(frame);
                continue;
            }

            if (frame._tag === "FoldCont") {
                if (!Cause.isFailureOnly(currentCause)) continue;
                const failure = Cause.firstFailure(currentCause);
                if (failure._tag === "None") break;
                try {
                    this.current = frame.onFailure(failure.value);
                    return;
                } catch (error) {
                    currentCause = Cause.fail(error as E);
                    continue;
                }
            }
        }

        this.notify(Exit.failCause(currentCause));
    }

    private notify(exit: Exit<E, A>): void {
        if (this.result) return;
        this.result = exit;
        this.runFinalizers(exit);
        for (const joiner of this.joiners) joiner(exit);
        this.joiners.length = 0;
    }

    private runFinalizers(exit: Exit<E, A>): void {
        while (this.finalizers.length > 0) {
            const finalizer = this.finalizers.pop()!;
            try {
                const result = finalizer(exit);
                if (result && typeof result === "object" && "_tag" in result) {
                    this.runtime.unsafeRunAsync(result as any, () => undefined);
                }
            } catch {
                // Best effort, matching RuntimeFiber finalizer behavior.
            }
        }
    }

    private fiberRefs(): Map<number, unknown> {
        this.frame.fiberContext.fiberRefs ??= new Map<number, unknown>();
        return this.frame.fiberContext.fiberRefs;
    }

    private restoreFiberRef(frame: { refId: number; hadValue: boolean; previousValue: unknown }): void {
        const refs = this.fiberRefs();
        if (frame.hadValue) refs.set(frame.refId, frame.previousValue);
        else refs.delete(frame.refId);
    }

    private withFrame<T>(body: () => T): T {
        return withCurrentFiber(this.frame, body);
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
