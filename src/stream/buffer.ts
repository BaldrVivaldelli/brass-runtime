/*
import {ZStream} from "./stream";

type Signal<E, A> =
    | { _tag: "Elem"; value: A }
    | { _tag: "End" }
    | { _tag: "Fail"; error: E }
function buffer<R, E, A>(
    stream: ZStream<R, E, A>,
    capacity: number,
    strategy: "backpressure" | "dropping" | "sliding" = "backpressure",
): ZStream<R, E, A> {
    return new ZStream((scope) =>
        Async.gen(function* (_) {
            const pullUp = yield* _(stream.open(scope))
            const q = yield* _(Queue.bounded<Signal<E, A>>(capacity, strategy))

            // Producer fiber: llena la cola
            const producer = yield* _(Async.forkScoped(scope, // importante: scoped para que se interrumpa al cerrar
                Async.forever(
                    pullUp.foldCauseAsync(
                        // upstream terminó/falló
                        (cause) =>
                            cause.match({
                                end: () => q.offer({ _tag: "End" }).unit(),
                                fail: (e) => q.offer({ _tag: "Fail", error: e }).unit(),
                            }),
                        // got elem
                        (a) => q.offer({ _tag: "Elem", value: a }).unit(),
                    )
                )
            ))

            // Downstream Pull
            const pullDown: Pull<R, E, A> = q.take().flatMap((sig) => {
                switch (sig._tag) {
                    case "Elem": return Async.succeed(sig.value)
                    case "End":  return Async.fail(None)        // fin del stream
                    case "Fail": return Async.fail(Some(sig.error))
                }
            })

            // Importante: si el consumidor termina antes,
            // el scope debería interrumpir producer automáticamente.
            return pullDown
        })
    )
}
*/
