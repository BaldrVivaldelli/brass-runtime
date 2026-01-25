import { Interrupted } from "../core/runtime/fiber";
import type { Exit } from "../core/types/effect";

import { collectStream, fromArray, mapStream } from "../core/stream/stream";
import { withScope } from "../core/runtime/scope";

import { async, type Async, asyncFlatMap, asyncSucceed } from "../core/types/asyncEffect";
import { succeed } from "../core/types/effect";
import { Runtime } from "../core/runtime/runtime"; // 👈 usar Runtime

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
function run<E, A>(runtime: Runtime<Env>, label: string, eff: Async<Env, E, A>) {
    const f = runtime.fork(eff as any);
    f.join((exit: Exit<unknown, unknown>) => {
        const ex = exit as Exit<E, A>;
        console.log(label, ex);
    });
    return f;
}

function main() {
    const env: Env = {};
    const runtime = new Runtime({ env });

    // Fibras simples
    const fiberA = run<Interrupted, string>(runtime, "Fiber A:", task("A", 1000) as any);
    const fiberB = run<Interrupted, string>(runtime, "Fiber B:", task("B", 500) as any);

    // “zip” de efectos
    const eff1 = succeed(10);
    const eff2 = succeed(20);
    const sumEff: Async<Env, never, [number, number]> =
        asyncFlatMap(eff1 as any, (a: number) =>
            asyncFlatMap(eff2 as any, (b: number) => asyncSucceed([a, b] as [number, number]))
        );

    run(runtime, "zip(eff1, eff2):", sumEff as any);

    // foreach sobre array
    const nums = [1, 2, 3];
    const foreachEff: Async<Env, never, number[]> = nums.reduce(
        (accEff, n) =>
            asyncFlatMap(accEff as any, (acc: number[]) =>
                asyncFlatMap(succeed(n * 2) as any, (m: number) => asyncSucceed([...acc, m]))
            ),
        asyncSucceed([] as number[])
    );

    run(runtime, "foreach array:", foreachEff as any);

    // Stream map + collect
    const s = fromArray([1, 2, 3, 4]);
    const sMapped = mapStream(s, (n) => n * 10);
    const collectedEff = collectStream(sMapped);

    run(runtime, "Stream mapeado:", collectedEff as any);

    // Scope (ahora recibe runtime)
    withScope(runtime, (scope) => {
        const f1 = scope.fork(task("A", 1000));
        const f2 = scope.fork(task("B", 1500));
        const f3 = scope.fork(task("C", 2000));

        console.log("Tareas lanzadas dentro del scope");

        setTimeout(() => {
            console.log("CANCELANDO TODO EL SCOPE...");
            scope.close();
        }, 1200);

        f1.join(console.log);
        f2.join(console.log);
        f3.join(console.log);
    });

    fiberA.join(() => {});
    fiberB.join(() => {});
}

main();
