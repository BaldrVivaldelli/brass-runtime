import {async, Async, asyncCatchAll, asyncFlatMap, asyncSync} from "../core/types/asyncEffect";
import {makeHub} from "../core/stream/hub";
import {fork, unsafeRunAsync} from "../core/runtime/runtime";
import {QueueClosed} from "../core/stream/queue";
import {Fiber, Interrupted} from "../core/runtime/fiber";
import {Exit} from "../core/types/effect";

const log = (msg: string): Async<unknown, any, void> =>
    asyncSync(() => console.log(msg));


const isQueueClosed = (e: unknown): e is QueueClosed =>
    typeof e === "object" && e !== null && (e as any)._tag === "QueueClosed";

const consumer = <A>(
    name: string,
    sub: { take: () => Async<unknown, any, A> }
) => {
    const loop = (): Async<unknown, any, void> =>
        asyncCatchAll(
            asyncFlatMap(sub.take(), (a) =>
                asyncFlatMap(log(`[${name}] got ${String(a)}`), () => loop())
            ),
            (e) =>
                isQueueClosed(e)
                    ? log(`[${name}] closed`)
                    : log(`[${name}] ERROR ${String(e)}`)
        );

    return loop();
};

const hub = makeHub<number>(8, "Dropping"); // para broadcast suele ir mejor Dropping/Sliding

//TODO: Pensar si lo subo a fiber, porque seguramente se use mucho y hay que ver la forma de meterlo en el ciclo de vida
const awaitFiber = <E, A>(f: Fiber<E, A>): Async<unknown, E | Interrupted, A> =>
  async((_env, cb: (exit: Exit<E | Interrupted, A>) => void) => {
    f.join(cb);
  });


const program =
    asyncFlatMap(hub.subscribe(), (sub1) =>
        asyncFlatMap(hub.subscribe(), (sub2) =>
            asyncFlatMap(
                // fork dentro del Async
                asyncSync(() => {
                    const f1 = fork(consumer("sub-1", sub1), {});
                    const f2 = fork(consumer("sub-2", sub2), {});
                    return { f1, f2 };
                }),
                ({ f1, f2 }) =>
                    asyncFlatMap(log("[main] publish 1..5"), () =>
                        asyncFlatMap(hub.publishAll([1, 2, 3, 4, 5]), () =>
                            asyncFlatMap(hub.shutdown(), () =>
                                asyncFlatMap(awaitFiber(f1), () =>
                                    asyncFlatMap(awaitFiber(f2), () =>
                                        log("[main] joined both")
                                    )
                                )
                            )
                        )
                    )
            )
        )
    );


unsafeRunAsync(program, {}, (exit) => {
    console.log("[main] done:", exit);
});