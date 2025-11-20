// ----- ADT de Stream -----

import {
    fail,
    flatMap,
    map,
    mapError,
    orElseOptional,
    succeed,
    ZIO,
} from "../types/effect.js";
import { none, Option, some } from "../types/option.js";

export type Empty<R, E, A> = { readonly _tag: "Empty" };

export type Emit<R, E, A> = {
    readonly _tag: "Emit";
    readonly value: ZIO<R, E, A>;
};

export type Concat<R, E, A> = {
    readonly _tag: "Concat";
    readonly left: ZStream<R, E, A>;
    readonly right: ZStream<R, E, A>;
};

export type Flatten<R, E, A> = {
    readonly _tag: "Flatten";
    readonly stream: ZStream<R, E, ZStream<R, E, A>>;
};

export type ZStream<R, E, A> =
    | Empty<R, E, A>
    | Emit<R, E, A>
    | Concat<R, E, A>
    | Flatten<R, E, A>;

// ----- Constructores helpers -----

export const emptyStream = <R, E, A>(): ZStream<R, E, A> => ({
    _tag: "Empty",
});

export const emitStream = <R, E, A>(value: ZIO<R, E, A>): ZStream<R, E, A> => ({
    _tag: "Emit",
    value,
});

export const concatStream = <R, E, A>(
    left: ZStream<R, E, A>,
    right: ZStream<R, E, A>
): ZStream<R, E, A> => ({
    _tag: "Concat",
    left,
    right,
});

export const flattenStream = <R, E, A>(
    stream: ZStream<R, E, ZStream<R, E, A>>
): ZStream<R, E, A> => ({
    _tag: "Flatten",
    stream,
});

// ----- uncons: ZIO[R, Option[E], (A, ZStream)] -----

export function uncons<R, E, A>(
    self: ZStream<R, E, A>
): ZIO<R, Option<E>, [A, ZStream<R, E, A>]> {
    switch (self._tag) {
        case "Empty":
            // fin de stream => Failure(None)
            return fail<Option<E>>(none);

        case "Emit":
            // value.mapError(Some(_)).map(a => (a, Empty))
            return map(
                mapError(self.value, (e) => some<E>(e)),
                (a): [A, ZStream<R, E, A>] => [a, emptyStream<R, E, A>()]
            );

        case "Concat":
            // left.uncons.map(...).orElseOptional(right.uncons)
            return orElseOptional(
                map(
                    uncons(self.left),
                    ([a, tail]): [A, ZStream<R, E, A>] => [
                        a,
                        concatStream<R, E, A>(tail, self.right),
                    ]
                ),
                () => uncons(self.right)
            );

        case "Flatten":
            // stream.uncons.flatMap { case (head, tail) =>
            //   head.uncons
            //     .map { case (a, as) => (a, as ++ Flatten(tail)) }
            //     .orElseOptional(Flatten(tail).uncons)
            // }
            return flatMap(uncons(self.stream), ([head, tail]) =>
                orElseOptional(
                    map(
                        uncons(head),
                        ([a, as]): [A, ZStream<R, E, A>] => [
                            a,
                            concatStream<R, E, A>(as, flattenStream<R, E, A>(tail)),
                        ]
                    ),
                    () => uncons(flattenStream<R, E, A>(tail))
                )
            );
    }
}

// ---------- combinadores extra opcionales ----------

export function mapStream<R, E, A, B>(
    self: ZStream<R, E, A>,
    f: (a: A) => B
): ZStream<R, E, B> {
    switch (self._tag) {
        case "Empty":
            return emptyStream<R, E, B>();

        case "Emit":
            return emitStream<R, E, B>(map(self.value, f));

        case "Concat":
            return concatStream<R, E, B>(
                mapStream(self.left, f),
                mapStream(self.right, f)
            );

        case "Flatten": {
            const mappedOuter: ZStream<R, E, ZStream<R, E, B>> = mapStream(
                self.stream,
                (inner) => mapStream(inner, f)
            );
            return flattenStream<R, E, B>(mappedOuter);
        }
    }
}

// Stream finito desde un array
export function fromArray<A>(values: readonly A[]): ZStream<unknown, never, A> {
    let s: ZStream<unknown, never, A> = emptyStream<unknown, never, A>();

    for (let i = values.length - 1; i >= 0; i--) {
        const head = emitStream<unknown, never, A>(succeed(values[i]!));
        s = concatStream<unknown, never, A>(head, s);
    }

    return s;
}

// Consumidor síncrono del stream
export function collectStream<R, A>(
    stream: ZStream<R, unknown, A>,
    env: R
): A[] {
    const result: A[] = [];
    let current: ZStream<R, unknown, A> = stream;

    while (true) {
        const exit = uncons(current)(env);

        if (exit._tag === "Failure") {
            const optErr = exit.error;
            if (optErr._tag === "None") {
                // fin del stream
                return result;
            } else {
                // error real
                throw optErr.value;
            }
        } else {
            const [head, tail] = exit.value;
            result.push(head);
            current = tail;
        }
    }
}
