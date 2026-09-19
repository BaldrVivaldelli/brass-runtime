// src/core/runtime/scope.ts
import { Fiber, getCurrentFiber } from "./fiber";
import { Cause, Exit } from "../types/effect";
import { async, Async, asyncFail, asyncFlatMap, asyncFold, asyncSync, unit } from "../types/asyncEffect";
import { Runtime } from "./runtime";

export type ScopeId = number;

type CloseOptions = { awaitChildren?: boolean };
let nextScopeId = 1;

export type ScopeFinalizerFailure = {
    readonly scopeId: ScopeId;
    readonly finalizerId: number;
    readonly error: unknown;
};

export class ScopeFinalizerError extends Error {
    readonly _tag = "ScopeFinalizerError" as const;

    constructor(readonly failures: readonly ScopeFinalizerFailure[]) {
        super(`${failures.length} scope finalizer${failures.length === 1 ? "" : "s"} failed`);
        this.name = "ScopeFinalizerError";
    }
}

// espera a que todos los fibers terminen (sin fallar)
function awaitAll<E, A>(fibers: Fiber<E, A>[]): Async<any, never, void> {
    return async((_env, cb) => {
        let remaining = fibers.length;
        if (remaining === 0) {
            cb({ _tag: "Success", value: undefined });
            return;
        }
        for (const f of fibers) {
            f.join(() => {
                remaining -= 1;
                if (remaining === 0) cb({ _tag: "Success", value: undefined });
            });
        }
    });
}

class Scope<R> {
    readonly id: ScopeId;

    private closed = false;

    private readonly children = new Set<Fiber<any, any>>();
    private readonly subScopes = new Set<Scope<R>>();
    private readonly finalizers: Array<(exit: Exit<any, any>) => Async<R, any, any>> = [];
    private readonly failedFinalizers: ScopeFinalizerFailure[] = [];

    constructor(private readonly runtime: Runtime<R>, private readonly parentScopeId?: ScopeId) {
        this.id = nextScopeId++;
        this.runtime.recordScopeOpened();

        const inferredParent = this.parentScopeId ?? (getCurrentFiber() as any)?.scopeId;

        // ✅ scope.open — skip event object construction when no hooks are active
        if (this.runtime.hasActiveHooks()) {
            this.runtime.emit({
                type: "scope.open",
                scopeId: this.id,
                parentScopeId: inferredParent,
            });
        }
    }

    /** registra un finalizer (LIFO) */
    addFinalizer(f: (exit: Exit<any, any>) => Async<R, any, any>): void {
        if (this.closed) {
            throw new Error("Trying to add finalizer to closed scope");
        }
        this.finalizers.push(f);
        this.runtime.recordScopeFinalizerAdded();
        if (this.runtime.hasActiveHooks()) {
            this.runtime.emit({
                type: "scope.finalizer.add",
                scopeId: this.id,
                finalizerId: this.finalizers.length,
            });
        }
    }

    /** crea un sub scope (mismo runtime) */
    subScope(): Scope<R> {
        if (this.closed) throw new Error("Scope closed");
        const s = new Scope<R>(this.runtime, this.id);
        this.subScopes.add(s);
        return s;
    }

    /** Snapshot of cleanup failures. Descendant scopes are included by default. */
    finalizerFailures(options: { recursive?: boolean } = {}): readonly ScopeFinalizerFailure[] {
        const failures = [...this.failedFinalizers];
        if (options.recursive ?? true) {
            for (const scope of this.subScopes) failures.push(...scope.finalizerFailures());
        }
        return Object.freeze(failures.slice());
    }

    /** ✅ fork en este scope */
    fork<E, A>(eff: Async<R, E, A>): Fiber<E, A> {
        if (this.closed) throw new Error("Scope closed");

        const f = this.runtime.fork(eff, this.id);

        this.children.add(f);
        f.join(() => this.children.delete(f));

        return f;
    }

    /** close fire-and-forget (no bloquea) */
    close(exit: Exit<any, any> = { _tag: "Success", value: undefined }): void {
        this.runtime.fork(this.closeAsync(exit));
    }

    /** Emit the scope.close event if hooks are active. */
    private emitCloseEvent(exit: Exit<any, any>, finalizerDurationMs: number): void {
        if (this.runtime.hasActiveHooks()) {
            const finalizerFailures = this.finalizerFailures();
            const status =
                finalizerFailures.length > 0
                    ? "failure"
                    : exit._tag === "Success"
                    ? "success"
                    : Cause.isInterruptedOnly(exit.cause)
                        ? "interrupted"
                        : "failure";
            const failure = exit._tag === "Failure" ? Cause.firstFailure(exit.cause) : undefined;
            const cleanupError = finalizerFailures[0]?.error;

            this.runtime.emit({
                type: "scope.close",
                scopeId: this.id,
                status,
                finalizerCount: this.finalizers.length,
                finalizerFailureCount: finalizerFailures.length,
                finalizerDurationMs,
                error: cleanupError ?? (failure?._tag === "Some" ? failure.value : exit._tag === "Failure" ? exit.cause : undefined),
            });
        }
    }

    private finishFinalizer(finalizerId: number, status: "success" | "failure", error?: unknown): void {
        this.runtime.recordScopeFinalizerFinished();
        if (status === "failure") {
            this.failedFinalizers.push(Object.freeze({ scopeId: this.id, finalizerId, error }));
        }
        if (this.runtime.hasActiveHooks()) {
            this.runtime.emit({
                type: "scope.finalizer.end",
                scopeId: this.id,
                finalizerId,
                status,
                ...(error === undefined ? {} : { error }),
            });
        }
    }

    /**
     * Build an effect that executes finalizers in LIFO order.
     *
     * Optimization over the original: instead of wrapping every finalizer in
     * `asyncFold(fin(exit), () => unit(), () => unit())` which creates 3 effect
     * nodes per finalizer (Fold + 2 Succeed), we use a single Sync thunk per
     * finalizer that catches errors inline.  When the finalizer returns a
     * Succeed effect (like `unit()`), the Sync thunk completes without creating
     * additional effect nodes.
     */
    private buildFinalizerEffect(exit: Exit<any, any>): Async<R, any, void> {
        const fins = this.finalizers;
        if (fins.length === 0) return unit<R>() as any;

        // Build the chain in LIFO order (last added → first executed).
        let chain: Async<R, any, void> = unit<R>() as any;

        for (let i = fins.length - 1; i >= 0; i--) {
            const fin = fins[i];
            const finalizerId = i + 1;

            chain = asyncFlatMap(chain, () => {
                if (this.runtime.hasActiveHooks()) {
                    this.runtime.emit({ type: "scope.finalizer.start", scopeId: this.id, finalizerId });
                }
                let result: Async<R, any, any>;
                try {
                    result = fin(exit);
                } catch (error) {
                    // Best-effort close continues, but the failure remains observable.
                    this.finishFinalizer(finalizerId, "failure", error);
                    return unit<R>() as any;
                }

                // Fast-path: if the finalizer returned a Succeed effect (e.g. unit()),
                // skip the asyncFold wrapper entirely — no Fold node needed.
                if (result._tag === "Succeed") {
                    this.finishFinalizer(finalizerId, "success");
                    return unit<R>() as any;
                }

                // Non-trivial effect: wrap with asyncFold to swallow errors
                return asyncFold(
                    result,
                    (error) => asyncSync(() => {
                        this.finishFinalizer(finalizerId, "failure", error);
                    }),
                    () => asyncSync(() => {
                        this.finishFinalizer(finalizerId, "success");
                    })
                );
            });
        }

        return chain;
    }

    closeAsync(
        exit: Exit<any, any> = { _tag: "Success", value: undefined },
        opts: CloseOptions = { awaitChildren: true }
    ): Async<R, any, void> {
        return asyncFlatMap(unit<R>(), () =>
            async((env, cb) => {
                if (this.closed) {
                    cb({ _tag: "Success", value: undefined });
                    return;
                }
                this.closed = true;

                const children = Array.from(this.children);
                const subScopes = Array.from(this.subScopes);

                // Closing a scope is the structured-concurrency boundary:
                // all fibers owned by the scope must be interrupted before
                // we await them, otherwise closeAsync can hang forever on
                // long-running child work.
                for (const child of children) {
                    child.interrupt();
                }

                // 1) close subscopes
                const closeSubs = subScopes.reduceRight(
                    (acc, s) => asyncFlatMap(acc, () => s.closeAsync(exit, opts)),
                    unit<R>() as any
                );

                // 2) run finalizers LIFO — optimized: sync finalizers skip Fold wrapping
                const runFinalizers = this.buildFinalizerEffect(exit);

                // 3) optionally await children
                const needsAwait = opts.awaitChildren && children.length > 0;
                const awaitChildrenEff = needsAwait ? (awaitAll(children) as any) : (unit<R>() as any);

                // Fast-path: when there are no sub-scopes, no children to await,
                // and no finalizers, we can complete immediately without forking.
                const hasSubScopes = subScopes.length > 0;
                const hasNoFinalizers = this.finalizers.length === 0;

                if (!hasSubScopes && !needsAwait && hasNoFinalizers) {
                    this.runtime.recordScopeClosed(0);
                    this.emitCloseEvent(exit, 0);
                    cb({ _tag: "Success", value: undefined });
                    return;
                }

                let finalizerStartedAt = 0;
                let finalizerDurationMs = 0;
                const timedFinalizers = asyncFlatMap(
                    asyncSync(() => {
                        finalizerStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
                    }),
                    () => asyncFlatMap(runFinalizers, () => asyncSync(() => {
                        const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
                        finalizerDurationMs = Math.max(0, endedAt - finalizerStartedAt);
                    })),
                );
                const all = asyncFlatMap(closeSubs, () => asyncFlatMap(awaitChildrenEff, () => timedFinalizers));
                this.runtime.fork(all as any).join(() => {
                    this.runtime.recordScopeClosed(finalizerDurationMs);
                    this.emitCloseEvent(exit, finalizerDurationMs);
                    cb({ _tag: "Success", value: undefined });
                });
            })
        );
    }

    /**
     * Close the complete scope tree and fail only after every finalizer has had
     * a chance to run. `closeAsync` remains the compatibility best-effort API.
     */
    closeAsyncStrict(
        exit: Exit<any, any> = { _tag: "Success", value: undefined },
        opts: CloseOptions = { awaitChildren: true }
    ): Async<R, ScopeFinalizerError, void> {
        return asyncFlatMap(this.closeAsync(exit, opts), () => {
            const failures = this.finalizerFailures();
            return failures.length > 0
                ? asyncFail(new ScopeFinalizerError(failures))
                : unit<R>();
        }) as Async<R, ScopeFinalizerError, void>;
    }
}

export function withScopeAsync<R, E, A>(
    runtime: Runtime<R>,
    f: (scope: Scope<R>) => Async<R, E, A>
): Async<R, E, A> {
    return async((_env, cb) => {
        const scope = new Scope<R>(runtime);
        let done = false;

        const completeAfterClose = (exit: Exit<E, A>) => {
            runtime.fork(scope.closeAsync(exit)).join(() => {
                if (done) return;
                done = true;
                cb(exit);
            });
        };

        const fiber = runtime.fork(f(scope));
        fiber.join(completeAfterClose as any);

        return () => {
            if (done) return;
            fiber.interrupt();
            runtime.fork(scope.closeAsync(Exit.failCause(Cause.interrupt())));
        };
    });
}

export { Scope };

// -----------------------------------------------------------------------------
// Convenience helper used by examples: allow a callback that returns `void`.
// If you return an Async, use withScopeAsync.
// -----------------------------------------------------------------------------

export function withScope<R>(runtime: Runtime<R>, f: (scope: Scope<R>) => void): Async<R, never, void>;
export function withScope<R, E, A>(runtime: Runtime<R>, f: (scope: Scope<R>) => Async<R, E, A>): Async<R, E, A>;
export function withScope<R, E, A>(
    runtime: Runtime<R>,
    f: (scope: Scope<R>) => void | Async<R, E, A>
): Async<R, any, any> {
    return withScopeAsync(runtime, (scope) => {
        const out = f(scope);
        // If callback returned an Async ADT, use it. Otherwise treat it as `void`.
        if (out && typeof out === "object" && "_tag" in out) return out;
        return unit<R>() as any;
    });
}
