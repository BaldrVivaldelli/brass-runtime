// src/scope.ts
import {Fiber, Interrupted} from "./fiber";
import {Exit} from "../types/effect";
import {Async} from "../types/asyncEffect";
import {fork} from "./runtime";

export type ScopeId = number;

let nextScopeId = 1;

export class Scope<R> {
    readonly id: ScopeId;

    private closed = false;

    private readonly children = new Set<Fiber<any, any>>();
    private readonly subScopes = new Set<Scope<R>>();
    private readonly finalizers: Array<(exit: Exit<any, any>) => Async<R, any, any>> = [];

    constructor(private readonly env: R) {
        this.id = nextScopeId++;
    }

    /** registra un finalizer (LIFO) */
    addFinalizer(f: (exit: Exit<any, any>) => Async<R, any, any>): void {
        if (this.closed) {
            throw new Error("Trying to add finalizer to closed scope");
        }
        this.finalizers.push(f);
    }

    /** crea un sub scope */
    subScope(): Scope<R> {
        if (this.closed) throw new Error("Scope closed");
        const s = new Scope<R>(this.env);
        this.subScopes.add(s);
        return s;
    }

    /** fork en este scope */
    fork<E, A>(eff: Async<R, E, A>, env: R): Fiber<E | Interrupted, A> {
        if (this.closed) throw new Error("Scope closed");

        const f = fork(eff, env);
        this.children.add(f);

        f.join(() => {
            this.children.delete(f);
        });

        return f;
    }

    close(exit: Exit<any, any> = { _tag: "Success", value: undefined }): void {
        if (this.closed) return;
        this.closed = true;
        this.children.forEach(f => f.interrupt());
        this.subScopes.forEach(s => s.close(exit));

        while (this.finalizers.length > 0) {
            const fin = this.finalizers.pop()!;
            const eff = fin(exit);
            fork(eff, this.env); // <-- esto hace que se ejecute el Async
        }

        this.children.clear();
        this.subScopes.clear();
    }

    isClosed(): boolean {
        return this.closed;
    }
}

/**
 * Ejecuta una función dentro de un scope estructurado.
 * Al final (éxito o error), se cierra el scope garantizando cleanup.
 */
export function withScope<R, A>(
    body: (scope: Scope<R>) => A
): A {
    const scope = new Scope<R>({} as R);
    try {
        return body(scope);
    } finally {
        scope.close();
    }
}
