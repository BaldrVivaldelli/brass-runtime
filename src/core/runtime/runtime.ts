import { async, Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";
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

/**
 * --- Runtime como objeto único (ZIO-style) ---
 * Un valor que representa "cómo" se ejecutan los efectos: scheduler + environment + hooks.
 */
export type RuntimeOptions<R> = {
    env: R;
    scheduler?: Scheduler;
    hooks?: RuntimeHooks;
    /**
     * Selects the fiber interpreter used by fork().
     *
     * - js: existing TypeScript RuntimeFiber interpreter.
     * - wasm: wasm-pack backed interpreter from wasm/pkg.
     * - wasm-reference: JS reference bridge with the same host/engine protocol.
     * - auto: try wasm first and fall back to js when the wasm package is not loadable.
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

    // opcional: registry para observabilidad
    registry?: RuntimeRegistry;

    constructor(args: RuntimeOptions<R>) {
        this.env = args.env;
        this.scheduler = args.scheduler ?? globalScheduler;
        this.hooks = args.hooks ?? NoopHooks;
        this.hostExecutor = args.hostExecutor ?? DefaultHostExecutor;
        this.engineMode = args.engine ?? "auto";
        this.wasmOptions = args.wasm;
        this.forkPolicy = makeForkPolicy(this.env as any, this.hooks);
        const selected = this.makeFiberEngine(this.engineMode, args.wasm);
        this.fiberEngine = selected.engine;
        this.fallbackUsed = selected.fallbackUsed;
    }

    private makeFiberEngine(mode: RuntimeEngineMode, wasm?: WasmFiberEngineOptions): { engine: FiberEngine<R>; fallbackUsed: boolean } {
        if (mode === "js") return { engine: new JsFiberEngine(this as any), fallbackUsed: false };
        if (mode === "wasm-reference") return { engine: new WasmFiberEngine(this as any, { ...wasm, reference: true }), fallbackUsed: false };
        if (mode === "wasm") return { engine: new WasmFiberEngine(this as any, wasm), fallbackUsed: false };

        // auto is explicit and observable: try the real WASM engine, but never
        // make default TS consumers fail when the wasm artifact is missing, not
        // copied by webpack, or missing one of the runtime exports.
        try {
            const capabilities = runtimeCapabilities();
            if (capabilities.wasmFiberEngine) {
                return { engine: new WasmFiberEngine(this as any, wasm), fallbackUsed: false };
            }
        } catch {
            // Fall through to JS. Explicit engine='wasm' still throws above.
        }
        return { engine: new JsFiberEngine(this as any), fallbackUsed: true };
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
        });
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

        // Si el caller provee scopeId (p.ej. Scope.fork), lo seteamos antes de initChild
        if (scopeId !== undefined) fiber.scopeId = scopeId;

        this.forkPolicy.initChild(fiber, parent as any, scopeId);
        fiber.schedule?.("initial-step");
        return fiber;
    }

    stats(): EngineStats<ReturnType<FiberEngine<R>["stats"]>> {
        const data = this.fiberEngine.stats();
        const engine = this.fiberEngine.kind === "js" ? "js" : "wasm";
        return { engine, fallbackUsed: this.fallbackUsed, data };
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

/**
 * Create an Async from an abortable Promise.
 * Type params are ordered as `<E, A, R = unknown>` to match call-sites.
 */
export function fromPromiseAbortable<E, A, R = unknown>(
    make: (signal: AbortSignal, env: R) => Promise<A>,
    onReject: (u: unknown) => E
): Async<R, E, A> {
    return {
        _tag: "Async",
        register: (env: R, cb: (exit: Exit<E, A>) => void) => {
            const controller = new AbortController();
            let done = false;

            make(controller.signal, env)
                .then((value) => {
                    if (done) return;
                    done = true;
                    cb(Exit.succeed(value));
                })
                .catch((err) => {
                    if (done) return;
                    done = true;
                   cb(Exit.failCause(Cause.fail(onReject(err))));
                });

            return () => {
                if (done) return;
                done = true;
                controller.abort();
                cb(Exit.failCause(Cause.interrupt()));
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