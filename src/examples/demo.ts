import {fork, Interrupted} from "../fibers/fiber";
import {Exit, foreach, succeed, zip} from "../types/effect";
import {collectStream, fromArray, mapStream} from "../stream/stream";
import {withScope} from "../scheduler/scope";
import {async, Async, asyncFlatMap, asyncSucceed} from "../types/asyncEffect";

function main() {

    const env: Env = {};

    const fiberA = fork(task("A", 1000), env);
    const fiberB = fork(task("B", 500), env);

    fiberA.join((exit: Exit<Interrupted, string>) => {
        console.log("Fiber A:", exit);
    });

    fiberB.join((exit: Exit<Interrupted, string>) => {
        console.log("Fiber B:", exit);
    });

    const eff1 = succeed(10);
    const eff2 = succeed(20);

    const sumEff = zip(eff1, eff2);
    const sumExit = sumEff({});
    console.log("sumExit:", sumExit);

    const numsEff = foreach([1, 2, 3], (n) => succeed(n * 2));
    console.log("foreach:", numsEff({}));

    const s = fromArray([1, 2, 3, 4]);
    const sMapped = mapStream(s, (n) => n * 10);
    const collected = collectStream(sMapped,env);
    console.log("Stream mapeado:", collected);



    withScope(scope => {
        const f1 = scope.fork(task("A", 1000), env);
        const f2 = scope.fork(task("B", 1500), env);
        const f3 = scope.fork(task("C", 2000), env);

        console.log("Tareas lanzadas dentro del scope");

        // Si quiero, cancelo todo luego de 1.2s
        setTimeout(() => {
            console.log("CANCELANDO TODO EL SCOPE...");
            scope.close();
        }, 1200);

        f1.join(console.log);
        f2.join(console.log);
        f3.join(console.log);
    });
}

type Env = {};
export function sleep(ms: number): Async<unknown, never, void> {
    return async((_, cb: (exit: Exit<never, void>) => void) => {
        setTimeout(() => {
            cb({ _tag: "Success", value: undefined });
        }, ms);
    });
}

function task(name: string, ms: number) {
    return asyncFlatMap(sleep(ms), () =>
        asyncSucceed(`Terminé ${name} después de ${ms}ms`)
    );
}

main();

