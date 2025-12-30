// fiberFinalizer.ts
import { asyncFlatMap, asyncTotal } from "../types/asyncEffect";
import { fork } from "../fibers/fiber";
import { sleep } from "./demo";

function formatExit(exit: any) {
    if (!exit || typeof exit !== "object") return String(exit);
    if (exit._tag === "Success") return `Success(value=${JSON.stringify(exit.value)})`;
    if (exit._tag === "Failure") return `Failure(error=${JSON.stringify(exit.error)})`;
    return JSON.stringify(exit);
}

function main() {
    const env = {};
    const t0 = Date.now();

    const eff =
        asyncFlatMap(asyncTotal(() => console.log("Start")), () =>
            asyncFlatMap(sleep(1000), () =>
                asyncTotal(() => "done")
            )
        );

    const fiber = fork(eff, env);

    // 👇 Instrumentación del finalizer
    let finCount = 0;
    fiber.addFinalizer((exit) =>
        asyncTotal(() => {
            finCount += 1;
            const ms = Date.now() - t0;

            const stack = new Error().stack
                ?.split("\n")
                .slice(1, 8) // primeras líneas útiles
                .join("\n");

            console.log("\n================ FINALIZER START ================");
            console.log(`time: +${ms}ms`);
            console.log(`finalizer call #: ${finCount}`);
            console.log(`exit: ${formatExit(exit)}`);
            console.log("raw exit object:", exit);
            console.log("stack (where finalizer ran):\n" + stack);
            console.log("================= FINALIZER END =================\n");
        })
    );

    // cancelamos antes de terminar para ver que el finalizer corre
    setTimeout(() => {
        console.log(`\n[+${Date.now() - t0}ms] Interrupting fiber...`);
        fiber.interrupt();
    }, 500);

    fiber.join((exit) => {
        console.log(`\n[+${Date.now() - t0}ms] Fiber completed:`, exit);
    });
}

main();
