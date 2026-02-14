// src/core/runtime/scope.ts
import { Fiber, getCurrentFiber } from "./fiber";
import { Exit } from "../types/effect";
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

        // ✅ scope.open
        this.runtime.emit({
            type: "scope.open",
            scopeId: this.id,
            parentScopeId: inferredParent,
        });
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

                // 1) close subscopes
                const closeSubs = subScopes.reduceRight(
                    (acc, s) => asyncFlatMap(acc, () => s.closeAsync(exit, opts)),
                    unit<R>() as any
                );

                // 2) run finalizers LIFO
                const runFinalizers = this.finalizers.reduceRight(
                    (acc, fin) =>
                        asyncFlatMap(acc, () =>
                            asyncFold(
                                fin(exit),              // ✅ NO se llama con (env, cb)
                                () => unit<R>(),
                                () => unit<R>()
                            )
                        ),
                    unit<R>() as any
                );

                // 3) optionally await children
                const awaitChildrenEff = opts.awaitChildren ? (awaitAll(children) as any) : (unit<R>() as any);

                const all = asyncFlatMap(closeSubs, () => asyncFlatMap(awaitChildrenEff, () => runFinalizers));
                this.runtime.fork(all as any).join(() => {
                    // ✅ scope.close al finalizar realmente
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
    return async((env, cb) => {
        const scope = new Scope<R>(runtime);
        runtime.fork(f(scope) as any).join((exit: any) => {
            // close scope siempre
            runtime.fork(scope.closeAsync(exit as any));
            cb(exit as any);
        });
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
        const out = f(scope) as any;
        // If callback returned an Async ADT, use it. Otherwise treat it as `void`.
        if (out && typeof out === "object" && "_tag" in out) return out;
        return unit<R>() as any;
    });
}
