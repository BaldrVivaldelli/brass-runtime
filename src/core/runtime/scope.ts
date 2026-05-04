// src/core/runtime/scope.ts
import { Fiber, getCurrentFiber } from "./fiber";
import { Cause, Exit } from "../types/effect";
import { async, Async, asyncFlatMap, asyncFold, unit } from "../types/asyncEffect";
import { Runtime } from "./runtime";

export type ScopeId = number;

type CloseOptions = { awaitChildren?: boolean };
let nextScopeId = 1;

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

    constructor(private readonly runtime: Runtime<R>, private readonly parentScopeId?: ScopeId) {
        this.id = nextScopeId++;

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
    }

    /** crea un sub scope (mismo runtime) */
    subScope(): Scope<R> {
        if (this.closed) throw new Error("Scope closed");
        const s = new Scope<R>(this.runtime, this.id);
        this.subScopes.add(s);
        return s;
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
    private emitCloseEvent(exit: Exit<any, any>): void {
        if (this.runtime.hasActiveHooks()) {
            const status =
                exit._tag === "Success"
                    ? "success"
                    : exit.cause._tag === "Interrupt"
                        ? "interrupted"
                        : "failure";

            this.runtime.emit({
                type: "scope.close",
                scopeId: this.id,
                status,
                error: exit._tag === "Failure" && exit.cause._tag === "Fail" ? (exit.cause as any).error : undefined,
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

            chain = asyncFlatMap(chain, () => {
                let result: Async<R, any, any>;
                try {
                    result = fin(exit);
                } catch {
                    // best-effort: never crash the runtime because of a finalizer
                    return unit<R>() as any;
                }

                // Fast-path: if the finalizer returned a Succeed effect (e.g. unit()),
                // skip the asyncFold wrapper entirely — no Fold node needed.
                if (result._tag === "Succeed") {
                    return unit<R>() as any;
                }

                // Non-trivial effect: wrap with asyncFold to swallow errors
                return asyncFold(
                    result,
                    () => unit<R>(),
                    () => unit<R>()
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
                    this.emitCloseEvent(exit);
                    cb({ _tag: "Success", value: undefined });
                    return;
                }

                const all = asyncFlatMap(closeSubs, () => asyncFlatMap(awaitChildrenEff, () => runFinalizers));
                this.runtime.fork(all as any).join(() => {
                    this.emitCloseEvent(exit);
                    cb({ _tag: "Success", value: undefined });
                });
            })
        );
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
