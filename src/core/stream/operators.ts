// src/core/stream/operators.ts
// Additional stream operators: throttle, debounce, zip, interleave, scan.
//
// These operators work with the ZStream ADT and produce new streams
// using the existing fromPull/uncons/asyncFold patterns.

import { none, Option, some } from "../types/option";
import { async, Async, asyncFail, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { fromPull, uncons, ZStream, emptyStream, concatStream, emitStream } from "./stream";
import { succeed } from "../types/effect";

// ---------------------------------------------------------------------------
// throttle — emit at most one element per interval
// ---------------------------------------------------------------------------

/**
 * Throttles a stream to emit at most one element per `intervalMs`.
 * Elements arriving during the cooldown period are dropped.
 *
 * ```ts
 * const throttled = throttle(clickStream, 1000); // max 1 click per second
 * ```
 */
export function throttle<R, E, A>(
  stream: ZStream<R, E, A>,
  intervalMs: number
): ZStream<R, E, A> {
  let lastEmitTime = 0;

  const loop = (cur: ZStream<R, E, A>): ZStream<R, E, A> =>
    fromPull(
      asyncFold(
        uncons(cur),
        (opt: Option<E>) => asyncFail(opt),
        ([a, tail]) => {
          const now = Date.now();
          if (now - lastEmitTime >= intervalMs) {
            lastEmitTime = now;
            return asyncSucceed([a, loop(tail)] as [A, ZStream<R, E, A>]);
          }
          // Drop this element and pull next
          return uncons(loop(tail)) as any;
        }
      ) as any
    );

  return loop(stream);
}

// ---------------------------------------------------------------------------
// debounce — emit only after silence of `delayMs`
// ---------------------------------------------------------------------------

/**
 * Debounces a stream: only emits an element after `delayMs` of silence.
 * If a new element arrives before the delay expires, the previous is dropped.
 *
 * Note: This is a simplified debounce that works by buffering the last element
 * and emitting it after a delay. For real-time use cases, consider using
 * the Hub-based approach with timers.
 *
 * ```ts
 * const debounced = debounce(inputStream, 300); // wait 300ms of silence
 * ```
 */
export function debounce<R, E, A>(
  stream: ZStream<R, E, A>,
  delayMs: number
): ZStream<R, E, A> {
  return fromPull(
    async((_env, cb) => {
      let lastValue: A | undefined;
      let hasValue = false;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      let tail: ZStream<R, E, A> = stream;

      const pullNext = () => {
        if (done) return;

        const pull = uncons(tail) as any;
        pull(_env, (exit: any) => {
          if (done) return;

          if (exit._tag === "Failure") {
            // End of stream or error
            if (hasValue) {
              // Emit the last buffered value
              const value = lastValue!;
              hasValue = false;
              clearTimeout(timerId);
              cb({ _tag: "Success", value: [value, emptyStream()] as any });
            } else {
              cb(exit);
            }
            return;
          }

          const [a, nextTail] = exit.value as [A, ZStream<R, E, A>];
          tail = nextTail;
          lastValue = a;
          hasValue = true;

          // Reset the timer
          clearTimeout(timerId);
          timerId = setTimeout(() => {
            if (done) return;
            const value = lastValue!;
            hasValue = false;
            done = true;
            cb({ _tag: "Success", value: [value, debounce(tail, delayMs)] as any });
          }, delayMs);

          // Pull next element (may arrive before timer fires)
          pullNext();
        });
      };

      pullNext();

      return () => {
        done = true;
        clearTimeout(timerId);
      };
    })
  );
}

// ---------------------------------------------------------------------------
// zip — combine two streams element-by-element
// ---------------------------------------------------------------------------

/**
 * Zips two streams together, pairing elements by position.
 * The resulting stream ends when either input stream ends.
 *
 * ```ts
 * const zipped = zip(numbersStream, lettersStream);
 * // [1, "a"], [2, "b"], [3, "c"], ...
 * ```
 */
export function zip<R, E, A, B>(
  left: ZStream<R, E, A>,
  right: ZStream<R, E, B>
): ZStream<R, E, [A, B]> {
  const loop = (l: ZStream<R, E, A>, r: ZStream<R, E, B>): ZStream<R, E, [A, B]> =>
    fromPull(
      asyncFold(
        uncons(l),
        (opt: Option<E>) => asyncFail(opt),
        ([a, lTail]) =>
          asyncFold(
            uncons(r),
            (opt: Option<E>) => asyncFail(opt),
            ([b, rTail]) =>
              asyncSucceed([[a, b] as [A, B], loop(lTail, rTail)] as [[A, B], ZStream<R, E, [A, B]>])
          )
      ) as any
    );

  return loop(left, right);
}

// ---------------------------------------------------------------------------
// zipWith — zip with a custom combiner function
// ---------------------------------------------------------------------------

/**
 * Zips two streams with a custom combiner function.
 *
 * ```ts
 * const summed = zipWith(xs, ys, (x, y) => x + y);
 * ```
 */
export function zipWith<R, E, A, B, C>(
  left: ZStream<R, E, A>,
  right: ZStream<R, E, B>,
  f: (a: A, b: B) => C
): ZStream<R, E, C> {
  const loop = (l: ZStream<R, E, A>, r: ZStream<R, E, B>): ZStream<R, E, C> =>
    fromPull(
      asyncFold(
        uncons(l),
        (opt: Option<E>) => asyncFail(opt),
        ([a, lTail]) =>
          asyncFold(
            uncons(r),
            (opt: Option<E>) => asyncFail(opt),
            ([b, rTail]) =>
              asyncSucceed([f(a, b), loop(lTail, rTail)] as [C, ZStream<R, E, C>])
          )
      ) as any
    );

  return loop(left, right);
}

// ---------------------------------------------------------------------------
// scan — running accumulator (like Array.reduce but streaming)
// ---------------------------------------------------------------------------

/**
 * Produces a stream of accumulated values using a reducer function.
 * Emits the initial value first, then each accumulated result.
 *
 * ```ts
 * const running = scan(numbersStream, 0, (acc, n) => acc + n);
 * // 0, 1, 3, 6, 10, ... (running sum)
 * ```
 */
export function scan<R, E, A, B>(
  stream: ZStream<R, E, A>,
  initial: B,
  f: (acc: B, a: A) => B
): ZStream<R, E, B> {
  const loop = (cur: ZStream<R, E, A>, acc: B): ZStream<R, E, B> =>
    fromPull(
      asyncFold(
        uncons(cur),
        (opt: Option<E>) => asyncFail(opt),
        ([a, tail]) => {
          const next = f(acc, a);
          return asyncSucceed([next, loop(tail, next)] as [B, ZStream<R, E, B>]);
        }
      ) as any
    );

  // Emit initial value first
  return concatStream(
    emitStream(succeed(initial)),
    loop(stream, initial)
  );
}

// ---------------------------------------------------------------------------
// interleave — alternate elements from two streams
// ---------------------------------------------------------------------------

/**
 * Interleaves two streams, alternating elements from each.
 * When one stream ends, remaining elements from the other are emitted.
 *
 * ```ts
 * const mixed = interleave(evens, odds);
 * // 0, 1, 2, 3, 4, 5, ...
 * ```
 */
export function interleave<R, E, A>(
  left: ZStream<R, E, A>,
  right: ZStream<R, E, A>
): ZStream<R, E, A> {
  const loop = (l: ZStream<R, E, A>, r: ZStream<R, E, A>, pickLeft: boolean): ZStream<R, E, A> =>
    fromPull(
      asyncFold(
        uncons(pickLeft ? l : r),
        // Current stream ended — drain the other
        (_opt: Option<E>) => uncons(pickLeft ? r : l) as any,
        ([a, tail]) => {
          const nextL = pickLeft ? tail : l;
          const nextR = pickLeft ? r : tail;
          return asyncSucceed([a, loop(nextL, nextR, !pickLeft)] as [A, ZStream<R, E, A>]);
        }
      ) as any
    );

  return loop(left, right, true);
}

// ---------------------------------------------------------------------------
// take / drop / filter as standalone functions (not pipeline)
// ---------------------------------------------------------------------------

/**
 * Takes the first N elements from a stream.
 */
export function take<R, E, A>(stream: ZStream<R, E, A>, n: number): ZStream<R, E, A> {
  if (n <= 0) return emptyStream();

  const loop = (cur: ZStream<R, E, A>, remaining: number): ZStream<R, E, A> => {
    if (remaining <= 0) return emptyStream();
    return fromPull(
      asyncFold(
        uncons(cur),
        (opt: Option<E>) => asyncFail(opt),
        ([a, tail]) => asyncSucceed([a, loop(tail, remaining - 1)] as [A, ZStream<R, E, A>])
      ) as any
    );
  };

  return loop(stream, n);
}

/**
 * Drops the first N elements from a stream.
 */
export function drop<R, E, A>(stream: ZStream<R, E, A>, n: number): ZStream<R, E, A> {
  if (n <= 0) return stream;

  const skip = (cur: ZStream<R, E, A>, remaining: number): ZStream<R, E, A> => {
    if (remaining <= 0) return cur;
    return fromPull(
      asyncFold(
        uncons(cur),
        (opt: Option<E>) => asyncFail(opt),
        ([_a, tail]) => uncons(skip(tail, remaining - 1)) as any
      ) as any
    );
  };

  return skip(stream, n);
}
