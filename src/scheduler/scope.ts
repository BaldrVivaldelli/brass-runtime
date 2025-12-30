// src/scope.ts
import {Fiber, Interrupted,fork} from "../fibers/fiber";
import {Exit} from "../types/effect";
import {Async} from "../types/asyncEffect";

export type ScopeId = number;

let nextScopeId = 1;

export class Scope<R> {
    readonly id: ScopeId;

    private closed = false;

    private readonly children = new Set<Fiber<any, any>>();
    private readonly subScopes = new Set<Scope<R>>();
    private readonly finalizers: Array<(exit: Exit<any, any>) => Async<R, any, any>> = [];

    constructor() {
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
        const s = new Scope<R>();
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

    /** Cierre estructurado */
    close(exit: Exit<any, any> = { _tag: "Success", value: undefined }): void {
        if (this.closed) return;
        this.closed = true;

        // 1) cancelar hijos
        for (const f of this.children) {
            f.interrupt();
        }

        // 2) cerrar sub scopes
        for (const s of this.subScopes) {
            s.close(exit);
        }

        // 3) ejecutar finalizers en orden LIFO
        while (this.finalizers.length > 0) {
            const fin = this.finalizers.pop()!;
            fin(exit); // se ejecuta como Async, pero no esperamos
        }

        this.children.clear();
        this.subScopes.clear();
    }

    isClosed(): boolean {
        return this.closed;
    }
}
