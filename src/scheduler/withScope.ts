// src/withScope.ts

import { Scope } from "./scope";

/**
 * Ejecuta una función dentro de un scope estructurado.
 * Al final (éxito o error), se cierra el scope garantizando cleanup.
 */
export function withScope<R, A>(
    body: (scope: Scope<R>) => A
): A {
    const scope = new Scope<R>();
    try {
        const result = body(scope);
        return result;
    } finally {
        scope.close(); // cleanup garantizado
    }
}
