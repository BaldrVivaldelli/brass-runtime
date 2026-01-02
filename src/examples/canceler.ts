import {async} from "../types/asyncEffect";
import {unsafeRunAsync} from "../runtime/runtime";

let ticks = 0;

const effect = async<unknown, never, void>((_env, cb) => {
    const id = setInterval(() => {
        ticks++;
    }, 10);

    cb({ _tag: "Success", value: undefined });
    return () => clearInterval(id);
});

unsafeRunAsync(effect, undefined, (exit) => {
    console.log("Fiber exit:", exit);
});

setTimeout(() => {
    const t1 = ticks;
    console.log("ticks @50ms:", t1);

    setTimeout(() => {
        const t2 = ticks;
        console.log("ticks @150ms:", t2);

        if (t2 > t1 + 1) {
            console.log("❌ LEAK: el interval siguió vivo después de terminar la fiber");
        } else {
            console.log("✅ OK: el interval se limpió (canceler ejecutado)");
        }
    }, 100);
}, 50);
