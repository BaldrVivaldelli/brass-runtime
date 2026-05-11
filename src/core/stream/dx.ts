import type { Runtime } from "../runtime/runtime";
import { collectStream, emptyStream, fromArray, rangeStream, type ZStream } from "./stream";
import { filterP, mapP, via, type ZPipeline } from "./pipeline";

export type Stream<A, R = unknown, E = never> = ZStream<R, E, A> & {
  readonly pipe: <Rp, Ep, B>(pipeline: ZPipeline<Rp, Ep, A, B>) => Stream<B, R & Rp, E | Ep>;
  readonly map: <B>(f: (value: A) => B) => Stream<B, R, E>;
  readonly filter: (predicate: (value: A) => boolean) => Stream<A, R, E>;
  readonly collect: (runtime: Runtime<R>) => Promise<A[]>;
};

export const Stream = Object.freeze({
  from: <A>(values: readonly A[]): Stream<A> => asStream(fromArray(values)),
  empty: <A = never>(): Stream<A> => asStream(emptyStream<unknown, never, A>()),
  range: (start: number, end: number): Stream<number> => asStream(rangeStream(start, end)),
  wrap: asStream,
});

export const Pipeline = Object.freeze({
  map: mapP,
  filter: filterP,
});

export function asStream<R, E, A>(stream: ZStream<R, E, A>): Stream<A, R, E> {
  const target = stream as Stream<A, R, E>;
  if (typeof target.pipe === "function") return target;

  Object.defineProperties(target, {
    pipe: {
      value<Rp, Ep, B>(pipeline: ZPipeline<Rp, Ep, A, B>) {
        return asStream(via(target, pipeline));
      },
    },
    map: {
      value<B>(f: (value: A) => B) {
        return asStream(via(target, mapP(f)));
      },
    },
    filter: {
      value(predicate: (value: A) => boolean) {
        return asStream(via(target, filterP(predicate)));
      },
    },
    collect: {
      value(runtime: Runtime<R>) {
        return runtime.toPromise(collectStream(target));
      },
    },
  });

  return target;
}
