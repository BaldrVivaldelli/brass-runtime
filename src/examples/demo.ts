import { Interrupted } from "../runtime/fiber";
import type { Exit } from "../types/effect";

import { collectStream, fromArray, mapStream } from "../stream/stream";
import { withScope } from "../runtime/scope";

import { async, type Async, asyncFlatMap, asyncSucceed } from "../types/asyncEffect";
import { succeed } from "../types/effect";
import {fork} from "../runtime/runtime"; // succeed ahora devuelve Async

type Env = {};

export function sleep(ms: number): Async<unknown, never, void> {
    return async((_, cb) => {
        const t = setTimeout(() => cb({ _tag: "Success", value: undefined }), ms);
        return () => clearTimeout(t);
    });
}

function task(name: string, ms: number): Async<unknown, never, string> {
    return asyncFlatMap(sleep(ms), () => asyncSucceed(`Terminé ${name} después de ${ms}ms`));
}

// Helper: correr un efecto y loguear su Exit
function run<E, A>(label: string, eff: Async<Env, E, A>, env: Env) {
    const f = fork(eff as any, env);
    f.join((exit: Exit<unknown, unknown>) => {
        const ex = exit as Exit<E, A>;
        console.log(label, ex);
    });
    return f;
}

function main() {
    const env: Env = {};

    // Fibras simples
    const fiberA = run<Interrupted, string>("Fiber A:", task("A", 1000) as any, env);
    const fiberB = run<Interrupted, string>("Fiber B:", task("B", 500) as any, env);

    // “zip” de efectos (sin helper): flatMap + map
    const eff1 = succeed(10);
    const eff2 = succeed(20);
    const sumEff: Async<Env, never, [number, number]> =
        asyncFlatMap(eff1 as any, (a: number) =>
            asyncFlatMap(eff2 as any, (b: number) => asyncSucceed([a, b] as [number, number]))
        );

    run("zip(eff1, eff2):", sumEff as any, env);

    // foreach sobre array (sin helper): secuenciar efectos
    const nums = [1, 2, 3];
    const foreachEff: Async<Env, never, number[]> = nums.reduce(
        (accEff, n) =>
            asyncFlatMap(accEff as any, (acc: number[]) =>
                asyncFlatMap(succeed(n * 2) as any, (m: number) => asyncSucceed([...acc, m]))
            ),
        asyncSucceed([] as number[])
    );

    run("foreach array:", foreachEff as any, env);

    // Stream map + collect (collectStream devuelve Async)
    const s = fromArray([1, 2, 3, 4]);
    const sMapped = mapStream(s, (n) => n * 10);
    const collectedEff = collectStream(sMapped); // <- ahora NO recibe env acá

    run("Stream mapeado:", collectedEff as any, env);

    // Scope
    withScope((scope) => {
        const f1 = scope.fork(task("A", 1000), env);
        const f2 = scope.fork(task("B", 1500), env);
        const f3 = scope.fork(task("C", 2000), env);

        console.log("Tareas lanzadas dentro del scope");

        setTimeout(() => {
            console.log("CANCELANDO TODO EL SCOPE...");
            scope.close();
        }, 1200);

        f1.join(console.log);
        f2.join(console.log);
        f3.join(console.log);
    });

    // (opcional) esperar a que terminen A/B si querés
    fiberA.join(() => {});
    fiberB.join(() => {});
}

main();
