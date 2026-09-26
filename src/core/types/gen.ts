/**
 * Generator-based composition for effects.
 *
 * `gen` turns nested `flatMap` chains into straight-line code without giving up
 * laziness: the generator body is only entered when the returned effect is
 * interpreted, and every execution gets its own iterator, so the resulting
 * value stays reusable like any other effect.
 */
import { asyncFlatMap, asyncSucceed, unit, type Async } from "./asyncEffect";

/**
 * A single `yield*` step. Wrapping the effect is what lets TypeScript infer a
 * distinct success type per step instead of collapsing them into one.
 */
export class GenEffect<R, E, A> {
  readonly _tag = "GenEffect" as const;

  constructor(readonly effect: Async<R, E, A>) {}

  *[Symbol.iterator](): Generator<GenEffect<R, E, A>, A, unknown> {
    return (yield this) as A;
  }
}

/** Lifts an effect into a `yield*`-able step. */
export type Adapter = <R, E, A>(effect: Async<R, E, A>) => GenEffect<R, E, A>;

const adapter: Adapter = (effect) => new GenEffect(effect);

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/**
 * Environments combine like `flatMap` does: as an intersection. The boxing step
 * is deliberate — a bare `infer R` union would let `unknown` from one step
 * swallow a real requirement from another.
 */
export type GenEnvironment<Eff> = [Eff] extends [never]
  ? unknown
  : UnionToIntersection<Eff extends GenEffect<infer R, any, any> ? { readonly _R: R } : never> extends {
        readonly _R: infer R;
      }
    ? R
    : never;

/**
 * Failures combine as a union, matching `flatMap`. `any` in the positions we do
 * not infer is load-bearing: `R` sits in contravariant position inside `Async`,
 * so `unknown` there would silently drop every step with a real requirement.
 */
export type GenFailure<Eff> = Eff extends GenEffect<any, infer E, any> ? E : never;

/**
 * Composes effects as straight-line code.
 *
 * ```ts
 * const program = gen(function* ($) {
 *   const user = yield* $(fetchUser(id));
 *   const orders = yield* $(fetchOrders(user.id));
 *   return { user, orders };
 * });
 * ```
 *
 * Nothing runs until the effect is interpreted, and interruption still happens
 * between steps because each `yield*` becomes an ordinary `FlatMap` node.
 */
export function gen<Eff extends GenEffect<any, any, any>, A>(
  body: ($: Adapter) => Generator<Eff, A, never>,
): Async<GenEnvironment<Eff>, GenFailure<Eff>, A> {
  return asyncFlatMap(unit(), () => {
    const iterator = body(adapter) as Generator<GenEffect<unknown, unknown, unknown>, A, unknown>;

    const step = (next: IteratorResult<GenEffect<unknown, unknown, unknown>, A>): Async<unknown, unknown, A> => {
      if (next.done === true) {
        return asyncSucceed(next.value);
      }
      return asyncFlatMap(next.value.effect, (produced) => step(iterator.next(produced)));
    };

    return step(iterator.next());
  }) as Async<GenEnvironment<Eff>, GenFailure<Eff>, A>;
}
