// src/fiber.ts
import { Cause, Exit } from "../types/effect";
import { Async } from "../types/asyncEffect";
import { globalScheduler, laneTag, Scheduler } from "./scheduler";
import { Runtime, unsafeRunAsync } from "./runtime";
import { FiberContext } from "./contex";
import type { RuntimeEvent } from "./events";

export type FiberId = number;
export type FiberStatus = "Running" | "Done" | "Interrupted";

// Public alias used across the codebase/examples.
export type Interrupted = { readonly _tag: "Interrupt" };

type StepDecision = "Continue" | "Suspend" | "Done";
type RunState = "Queued" | "Running" | "Suspended" | "Done";

let _current: RuntimeFiber<any, any, any> | null = null;

const STEP = {
    CONTINUE: "Continue",
    SUSPEND: "Suspend",
    DONE: "Done",
} as const satisfies Record<string, StepDecision>;

const TRAMPOLINE = {
    CONTINUE: 0,  // exited trampoline, more work to do via normal switch
    SUSPEND: 1,   // hit an async that didn't resolve synchronously
    DONE: 2,      // fiber completed (success or failure)
} as const;
type TrampolineResult = typeof TRAMPOLINE[keyof typeof TRAMPOLINE];

const RUN = {
    QUEUED: "Queued",
    RUNNING: "Running",
    SUSPENDED: "Suspended",
    DONE: "Done",
} as const satisfies Record<string, RunState>;

export type Fiber<E, A> = {
    readonly id: FiberId;
    readonly status: () => FiberStatus;
    readonly join: (cb: (exit: Exit<E, A>) => void) => void;
    readonly interrupt: () => void;
    // si querés soportar finalizers Async, cambiá esto a: (exit) => void | Async<...>
    readonly addFinalizer: (f: (exit: Exit<E, A>) => void) => void;
};

let nextId: FiberId = 1;

// cuántos opcodes sync procesa
const DEFAULT_BUDGET = 16384;

/**
 * Override for benchmarking purposes only.
 * When set to a positive number, the fiber uses this value instead of DEFAULT_BUDGET.
 * Call with `undefined` to reset after benchmarking.
 */
let __benchmarkBudget: number | undefined;

export function setBenchmarkBudget(budget: number | undefined): void {
  __benchmarkBudget = budget;
}

export function getBenchmarkBudget(): number | undefined {
  return __benchmarkBudget;
}

export class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    // 👇 CLAVE: guardar el runtime en el fiber (para getCurrentRuntime())
    readonly runtime: Runtime<R>;

    private closing: Exit<E, A> | null = null;
    private finishing = false;

    private runState: RunState = RUN.RUNNING;

    private interrupted = false;
    private result: Exit<E, A> | null = null;

    private readonly joiners: Array<(exit: Exit<E, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | {
            _tag: "FoldCont";
            onFailure: (e: any) => Async<R, E, any>;
            onSuccess: (a: any) => Async<R, E, any>;
        }
        | { _tag: "InterruptibilityCont"; previousDepth: number }
        | { _tag: "FiberRefCont"; refId: number; hadValue: boolean; previousValue: unknown }
    )[] = [];

    private readonly fiberFinalizers: Array<{ run?: (exit: Exit<E, A>) => any }> = [];
    private finalizersDrained = false;
    private interruptibilityDepth = 0;

    fiberContext!: FiberContext;
    name?: string;
    scopeId?: number;
    lane?: string;

    /**
     * Cached closure for the scheduler callback — avoids creating a new
     * closure on every `schedule()` call.  The tag parameter used by the
     * scheduler is only part of the label string, not the callback logic,
     * so a single cached closure is sufficient.
     */
    private readonly boundStep: () => void;

    // Reusable async callback state — avoids allocating a closure per Async step.
    // These fields are reset at the start of each Async case and reused.
    private _syncResolved = false;
    private _syncExit: Exit<E, any> | null = null;
    private _asyncRegistered = false;
    private _asyncDetach: (() => void) | undefined;
    private readonly _asyncCb: (exit: Exit<E, any>) => void;

    constructor(runtime: Runtime<R>, effect: Async<R, E, A>) {
        this.id = nextId++;
        this.runtime = runtime;
        this.current = effect;

        this._asyncCb = (exit: Exit<E, any>) => {
            if (this._syncResolved) return; // already handled (double-call guard)

            if (this.result != null || this.closing != null) return;

            // If register() hasn't returned yet, this is synchronous resolution
            if (!this._asyncRegistered) {
                this._syncResolved = true;
                this._syncExit = exit;
                return;
            }

            // Async path (callback fired after register returned)
            this._syncResolved = true; // mark as done
            this._asyncDetach?.();
            this._asyncDetach = undefined;

            if (exit._tag === "Success") {
                this.current = Async.succeed(exit.value);
                this.schedule("async-resume");
                return;
            }

            if (this.onCause(exit.cause)) {
                this.schedule("async-resume");
            }
        };

        this.boundStep = () => {
            withCurrentFiber(this, () => {
                if (this.runState === RUN.DONE) return;
                this.runState = RUN.RUNNING;

                const decision = this.step();

                switch (decision) {
                    case STEP.CONTINUE:
                        this.schedule("continue");
                        return;

                    case STEP.SUSPEND:
                        this.runState = RUN.SUSPENDED;
                        this.emit({ type: "fiber.suspend", fiberId: this.id });
                        return;

                    case STEP.DONE:
                        this.runState = RUN.DONE;
                        return;
                }
            });
        };
    }

    // helpers para no tocar el resto del código
    private get env(): R {
        return this.runtime.env;
    }
    private get scheduler(): Scheduler {
        return this.runtime.scheduler ?? globalScheduler;
    }

    private emit(ev: RuntimeEvent): void {
        // Emitimos con ctx del propio fiber (no dependemos de getCurrentFiber en callbacks async)
        this.runtime.hooks.emit(ev, {
            fiberId: this.id,
            scopeId: this.scopeId,
            traceId: this.fiberContext?.trace?.traceId,
            spanId: this.fiberContext?.trace?.spanId,
            parentSpanId: this.fiberContext?.trace?.parentSpanId,
            traceState: this.fiberContext?.trace?.traceState,
            baggage: this.fiberContext?.trace?.baggage,
            sampled: this.fiberContext?.trace?.sampled,
        });
    }

    addFinalizer(f: (exit: Exit<E, A>) => void): void {
        this.fiberFinalizers.push({ run: f });
    }

    /**
     * Internal finalizers used for suspend cancelers. They are detached as soon
     * as the async operation completes, so completed HTTP/promises do not keep
     * canceler closures alive until the fiber itself finishes.
     */
    private addTransientFinalizer(f: (exit: Exit<E, A>) => void): () => void {
        const rec: { run?: (exit: Exit<E, A>) => any } = { run: f };
        this.fiberFinalizers.push(rec);
        return () => {
            rec.run = undefined;
        };
    }

    status(): FiberStatus {
        if (this.result == null) return "Running";
        if (this.result._tag === "Failure" && Cause.isInterruptedOnly(this.result.cause)) return "Interrupted";
        return "Done";
    }

    join(cb: (exit: Exit<E, A>) => void): void {
        if (this.result != null) cb(this.result);
        else this.joiners.push(cb);
    }

    interrupt(): void {
        if (this.result != null) return;
        if (this.interrupted) return;
        this.interrupted = true;
        if (this.isInterruptible()) {
            this.schedule("interrupt-step");
        }
    }

    schedule(tag: string = "step"): void {
        // ya terminó o ya está en cola: no hacer nada
        if (this.runState === RUN.DONE || this.runState === RUN.QUEUED) return;

        // ✅ si venía suspendido, esto es un resume
        if (this.runState === RUN.SUSPENDED) {
            this.emit({ type: "fiber.resume", fiberId: this.id });
        }

        // encolamos
        this.runState = RUN.QUEUED;

        const label = `fiber#${this.id}.${tag}`;
        const result = this.scheduler.schedule(
            this.boundStep,
            this.lane ? laneTag(this.lane, label) : label
        );

        if (result === "dropped") {
            this.runState = RUN.DONE;
            this.notify(Exit.failCause(Cause.die<E>(new Error(`Brass scheduler dropped ${label} because the lane queue is full`))));
        }
    }

    private runFinalizersOnce(exit: Exit<E, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            const run = fin.run;
            fin.run = undefined;
            if (!run) continue;
            try {
                const eff = run(exit);

                // Si devolvió un Async (tu ADT), lo ejecutamos.
                if (eff && typeof eff === "object" && "_tag" in eff) {
                    unsafeRunAsync(eff as any, this.env as any, () => { });
                }
            } catch {
                // best-effort: jamás tumbar el runtime por un finalizer
            }
        }
    }

    private notify(exit: Exit<E, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ejecutar finalizers YA
        this.runFinalizersOnce(exit);

        this.result = exit;

        const status =
            exit._tag === "Success"
                ? "success"
                : Cause.isInterruptedOnly(exit.cause)
                    ? "interrupted"
                    : "failure";

        this.emit({
            type: "fiber.end",
            fiberId: this.id,
            status,
            error: exit._tag === "Failure" ? exit.cause : undefined,
        });

        for (const j of this.joiners) j(exit);
        this.joiners.length = 0;
    }

    private isInterruptible(): boolean {
        return this.interruptibilityDepth === 0;
    }

    private shouldInterruptNow(): boolean {
        return this.interrupted && this.isInterruptible();
    }

    private enterInterruptibility(mode: "uninterruptible" | "interruptible"): number {
        const previousDepth = this.interruptibilityDepth;
        this.interruptibilityDepth = mode === "uninterruptible" ? previousDepth + 1 : 0;
        return previousDepth;
    }

    private restoreInterruptibility(previousDepth: number): void {
        this.interruptibilityDepth = Math.max(0, previousDepth);
    }

    private fiberRefs(): Map<number, unknown> {
        const ctx = this.fiberContext as any;
        if (!ctx.fiberRefs) ctx.fiberRefs = new Map<number, unknown>();
        return ctx.fiberRefs;
    }

    private restoreFiberRef(frame: { refId: number; hadValue: boolean; previousValue: unknown }): void {
        const refs = this.fiberRefs();
        if (frame.hadValue) refs.set(frame.refId, frame.previousValue);
        else refs.delete(frame.refId);
    }

    private onSuccess(value: any): void {
        let currentValue = value;
        while (true) {
            const frame = this.stack.pop();
            if (!frame) {
                if (this.shouldInterruptNow()) {
                    this.notify(Exit.failCause(Cause.interrupt()));
                } else {
                    this.notify(Exit.succeed(currentValue));
                }
                return;
            }

            if (frame._tag === "InterruptibilityCont") {
                this.restoreInterruptibility(frame.previousDepth);
                if (this.shouldInterruptNow()) {
                    this.notify(Exit.failCause(Cause.interrupt()));
                    return;
                }
                continue;
            }

            if (frame._tag === "FiberRefCont") {
                this.restoreFiberRef(frame);
                continue;
            }

            if (frame._tag === "SuccessCont") {
                try {
                    this.current = frame.k(currentValue);
                } catch (e) {
                    // throw => defecto (no E)
                    this.notify(Exit.failCause(Cause.die<E>(e)));
                }
                return;
            }

            // si llega acá, era un FoldCont pero por success
            try {
                this.current = frame.onSuccess(currentValue);
            } catch (e) {
                this.notify(Exit.failCause(Cause.die<E>(e)));
            }
            return;
        }
    }

    private onFailure(error: any): void {
        this.onCause(Cause.fail(error as E));
    }

    private onCause(cause: Cause<E>): boolean {
        let currentCause = cause;

        while (this.stack.length > 0) {
            const fr = this.stack.pop()!;
            if (fr._tag === "InterruptibilityCont") {
                this.restoreInterruptibility(fr.previousDepth);
                if (this.shouldInterruptNow() && !Cause.isInterruptedOnly(currentCause)) {
                    currentCause = Cause.then(currentCause, Cause.interrupt()) as Cause<E>;
                }
                continue;
            }

            if (fr._tag === "FiberRefCont") {
                this.restoreFiberRef(fr);
                continue;
            }

            if (fr._tag === "FoldCont") {
                if (!Cause.isFailureOnly(currentCause)) continue;
                const failure = Cause.firstFailure(currentCause);
                if (failure._tag === "None") break;
                try {
                    this.current = fr.onFailure(failure.value);
                    return true;
                } catch (e) {
                    currentCause = Cause.fail(e as E);
                    continue;
                }
            }
            // SuccessCont se descarta
        }

        this.notify(Exit.failCause(currentCause));
        return false;
    }

    private budget = DEFAULT_BUDGET;

    private step(): StepDecision {
        if (this.result != null) return STEP.DONE;

        // interrupción cooperativa
        if (this.shouldInterruptNow()) {
            this.onCause(Cause.interrupt());
            return STEP.DONE;
        }

        // budget cooperativo — use benchmark override if set
        this.budget = __benchmarkBudget ?? DEFAULT_BUDGET;

        while (this.budget-- > 0) {
            // ─── Sync trampoline: unroll FlatMap chains that resolve synchronously ───
            // This is the critical optimization for queue/stream workloads where
            // thousands of FlatMap(Async(sync), k) are chained together.
            // Instead of going through the full switch/case per node, we stay in
            // a tight inner loop as long as each step resolves synchronously.
            if (this.current._tag === "FlatMap") {
                const trampolineResult = this.syncTrampoline();
                if (trampolineResult === TRAMPOLINE.DONE) {
                    return STEP.DONE;
                }
                if (trampolineResult === TRAMPOLINE.SUSPEND) {
                    return STEP.SUSPEND;
                }
                // TRAMPOLINE.CONTINUE means we exited the trampoline but have more work
                // (hit a non-FlatMap node or a non-sync Async). Fall through to normal switch.
                if (this.result != null) return STEP.DONE;
                if (this.budget <= 0) return STEP.CONTINUE;
            }

            const current: any = this.current;

            switch (current._tag) {
                case "Succeed": {
                    this.onSuccess(current.value);
                    break;
                }

                case "Fail": {
                    this.onFailure(current.error);
                    break;
                }

                case "FlatMap": {
                    this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                    this.current = current.first;
                    break;
                }

                case "Fold": {
                    this.stack.push({
                        _tag: "FoldCont",
                        onFailure: current.onFailure,
                        onSuccess: current.onSuccess,
                    });
                    this.current = current.first;
                    break;
                }

                case "Async": {
                    if (this.finishing) {
                        return this.result != null ? STEP.DONE : STEP.CONTINUE;
                    }

                    // Reset sync probe state (reused across all Async steps in this fiber)
                    this._syncResolved = false;
                    this._syncExit = null;
                    this._asyncRegistered = false;

                    const canceler = current.register(this.env, this._asyncCb);
                    this._asyncRegistered = true;

                    // Synchronous resolution: continue in the same step without re-enqueuing
                    if (this._syncResolved && this._syncExit) {
                        const resolvedExit = this._syncExit as Exit<E, any>;
                        this._syncExit = null; // release reference
                        if (resolvedExit._tag === "Success") {
                            this.onSuccess(resolvedExit.value);
                        } else {
                            this.onCause(resolvedExit.cause);
                        }
                        break; // continue the while loop
                    }

                    // Async path: register canceler as finalizer only when we actually suspend.
                    if (typeof canceler === "function") {
                        this._asyncDetach = this.addTransientFinalizer(() => {
                            if (this._syncResolved) return;
                            this._syncResolved = true;
                            this._asyncDetach = undefined;
                            try {
                                canceler();
                            } catch {
                                // ignore
                            }
                        });
                    }

                    return STEP.SUSPEND;
                }


                case "Fork": {
                    const child = this.runtime.fork(current.effect, current.scopeId);
                    this.onSuccess(child as any);
                    break;
                }

                case "Interruptibility": {
                    const previousDepth = this.enterInterruptibility(current.mode);
                    this.stack.push({ _tag: "InterruptibilityCont", previousDepth });
                    this.current = current.effect;
                    break;
                }

                case "InterruptibilityMask": {
                    const previousDepth = this.enterInterruptibility("uninterruptible");
                    this.stack.push({ _tag: "InterruptibilityCont", previousDepth });
                    try {
                        this.current = current.body((effect: Async<any, any, any>) => ({
                            _tag: "InterruptibilityRestore",
                            depth: previousDepth,
                            effect,
                        }));
                    } catch (e) {
                        this.onCause(Cause.die<E>(e));
                    }
                    break;
                }

                case "InterruptibilityRestore": {
                    const previousDepth = this.interruptibilityDepth;
                    this.restoreInterruptibility(current.depth);
                    this.stack.push({ _tag: "InterruptibilityCont", previousDepth });
                    this.current = current.effect;
                    break;
                }

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

                case "Sync": {
                    try {
                        const a = (current as any).thunk(this.env);
                        this.onSuccess(a);
                    } catch (e) {
                        this.onFailure(e);
                    }
                    break;
                }

                default: {
                    this.onFailure(new Error(`Unknown opcode: ${current._tag}`));
                    return STEP.CONTINUE;
                }
            }

            if (this.result != null) return STEP.DONE;
        }

        return STEP.CONTINUE;
    }

    /**
     * Sync trampoline: processes FlatMap chains in a tight loop without the
     * overhead of the general switch/case. Handles:
     * - FlatMap(Async(sync), k) — the queue/stream hot path
     * - FlatMap(Succeed(v), k) — pure value chains
     * - FlatMap(Sync(f), k) — synchronous thunks
     * - FlatMap(FlatMap(...), k) — left-associated chains (reassociates inline)
     * - FlatMap(Fold(...), k) — pushes fold frame and continues
     *
     * Returns TRAMPOLINE.CONTINUE when it hits a node it can't handle,
     * leaving this.current set to that node for the normal switch to process.
     */
    private syncTrampoline(): TrampolineResult {
        while (this.budget-- > 0) {
            let cur: any = this.current;

            // Handle left-associated FlatMap chains by pushing continuations to stack
            // instead of reassociating (which creates intermediate closures).
            // FlatMap(FlatMap(FlatMap(x, f), g), h) → push h, push g, process x then f
            while (cur._tag === "FlatMap" && cur.first?._tag === "FlatMap") {
                this.stack.push({ _tag: "SuccessCont", k: cur.andThen });
                cur = cur.first;
            }

            if (cur._tag !== "FlatMap") {
                this.current = cur;
                return TRAMPOLINE.CONTINUE;
            }

            const first = cur.first;
            const andThen = cur.andThen;

            switch (first._tag) {
                case "Succeed": {
                    // FlatMap(Succeed(v), k) → k(v)
                    try {
                        this.current = andThen(first.value);
                    } catch (e) {
                        this.notify(Exit.failCause(Cause.die<E>(e)));
                        return TRAMPOLINE.DONE;
                    }
                    continue;
                }

                case "Sync": {
                    // FlatMap(Sync(f), k) → k(f(env))
                    try {
                        const value = first.thunk(this.env);
                        this.current = andThen(value);
                    } catch (e) {
                        this.notify(Exit.failCause(Cause.die<E>(e)));
                        return TRAMPOLINE.DONE;
                    }
                    continue;
                }

                case "Fail": {
                    // FlatMap(Fail(e), k) → propagate failure up the stack
                    this.stack.push({ _tag: "SuccessCont", k: andThen });
                    this.current = first;
                    return TRAMPOLINE.CONTINUE; // let normal switch handle Fail
                }

                case "Async": {
                    if (this.finishing) {
                        this.current = cur;
                        return TRAMPOLINE.CONTINUE;
                    }

                    // Try synchronous resolution
                    this._syncResolved = false;
                    this._syncExit = null;
                    this._asyncRegistered = false;
                    const canceler = first.register(this.env, this._asyncCb);
                    this._asyncRegistered = true;

                    if (this._syncResolved && this._syncExit) {
                        const exit = this._syncExit as Exit<E, any>;
                        this._syncExit = null;
                        if (exit._tag === "Success") {
                            try {
                                this.current = andThen(exit.value);
                            } catch (e) {
                                this.notify(Exit.failCause(Cause.die<E>(e)));
                                return TRAMPOLINE.DONE;
                            }
                            continue;
                        } else {
                            // Failure in async — push continuation and propagate
                            this.stack.push({ _tag: "SuccessCont", k: andThen });
                            this.onCause(exit.cause);
                            return this.result != null ? TRAMPOLINE.DONE : TRAMPOLINE.CONTINUE;
                        }
                    }

                    // Didn't resolve synchronously — suspend
                    this.stack.push({ _tag: "SuccessCont", k: andThen });
                    if (typeof canceler === "function") {
                        this._asyncDetach = this.addTransientFinalizer(() => {
                            if (this._syncResolved) return;
                            this._syncResolved = true;
                            this._asyncDetach = undefined;
                            try { canceler(); } catch { }
                        });
                    }
                    return TRAMPOLINE.SUSPEND;
                }

                case "Fold": {
                    // FlatMap(Fold(first, onF, onS), k) → push both frames, continue with inner
                    this.stack.push({ _tag: "SuccessCont", k: andThen });
                    this.stack.push({
                        _tag: "FoldCont",
                        onFailure: first.onFailure,
                        onSuccess: first.onSuccess,
                    });
                    this.current = first.first;
                    continue;
                }

                default: {
                    // FlatMap(something else), let normal switch handle it
                    this.stack.push({ _tag: "SuccessCont", k: andThen });
                    this.current = first;
                    return TRAMPOLINE.CONTINUE;
                }
            }
        }

        // Budget exhausted
        return TRAMPOLINE.CONTINUE;
    }
}

export function getCurrentFiber() {
    return _current;
}

/**
 * Unsafe (but convenient) access to the runtime that is currently executing.
 * Throws if called outside of a running fiber.
 */
export function unsafeGetCurrentRuntime<R>(): Runtime<R> {
    const f = getCurrentFiber() as any;
    if (!f?.runtime) {
        throw new Error("unsafeGetCurrentRuntime: no current fiber/runtime");
    }
    return f.runtime as Runtime<R>;
}

export function withCurrentFiber<T>(fiber: RuntimeFiber<any, any, any>, f: () => T): T {
    const prev = _current;
    _current = fiber;
    try {
        return f();
    } finally {
        _current = prev;
    }
}
