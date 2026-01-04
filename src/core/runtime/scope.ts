// src/scope.ts
import {Fiber, Interrupted} from "./fiber";
import {Exit} from "../types/effect";
import {async, Async, asyncFlatMap, asyncFold, unit} from "../types/asyncEffect";
import {fork} from "./runtime";

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

// ignora errores del efecto (close nunca falla)
function ignoreErrors<R>(eff: Async<R, any, any>): Async<R, never, void> {
    return asyncFold(
        eff as any,
        () => unit as any,
        () => unit as any
    ) as any;
}

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
        // compat: fire-and-forget
        fork(this.closeAsync(exit), this.env);
    }

    closeAsync(
        exit: Exit<any, any> = { _tag: "Success", value: undefined },
        options: CloseOptions = {}
    ): Async<R, never, void> {
        return async((_env, cb) => {
            if (this.closed) {
                cb({ _tag: "Success", value: undefined });
                return;
            }
            this.closed = true;

            // snapshot para evitar carreras con mutaciones posteriores
            const children = Array.from(this.children);
            const subScopes = Array.from(this.subScopes);

            // “freeze” registries
            this.children.clear();
            this.subScopes.clear();

            // 1) Interrumpir children best-effort
            for (const f of children) {
                try { f.interrupt(); } catch {}
            }

            // 2) Construir efecto secuencial: cerrar subscopes

            let eff: Async<R, never, void> = unit<R>();

            for (const s of subScopes) {
                eff = asyncFlatMap(eff, () => s.closeAsync(exit, options));
            }

            // 3) Finalizers en LIFO, secuenciales, sin fallar
            while (this.finalizers.length > 0) {
                const fin = this.finalizers.pop()!;
                eff = asyncFlatMap(eff, () => ignoreErrors(fin(exit)));
            }

            // 4) (Opcional) esperar a que terminen children
            if (options.awaitChildren) {
                eff = asyncFlatMap(eff, () => awaitAll(children));
            }

            // Ejecutar eff y completar el closeAsync cuando termina
            const finFiber = fork(eff, this.env);
            finFiber.join(() => cb({ _tag: "Success", value: undefined }));
        });
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
