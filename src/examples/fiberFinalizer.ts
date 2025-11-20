// fiberFinalizer.ts

import {asyncFlatMap, asyncTotal} from "../types/asyncEffect";
import {fork} from "../fibers/fiber";
import {sleep} from "./demo";

function main() {
    const env = {};

    const eff =
        asyncFlatMap(asyncTotal(() => console.log("Start")), () =>
            asyncFlatMap(sleep(1000), () =>
                asyncTotal(() => "done")));

    const fiber = fork(eff, env);

    fiber.addFinalizer(exit =>
        asyncTotal(() => {
            console.log("RUNNING FINALIZER → exit =", exit._tag);
        })
    );

    // cancelamos antes de terminar para ver que el finalizer corre
    setTimeout(() => {
        console.log("Interrupting fiber...");
        fiber.interrupt();
    }, 500);

    fiber.join((exit) => {
        console.log("Fiber completed:", exit);
    });
}

main();
