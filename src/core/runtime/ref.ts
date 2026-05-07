// src/core/runtime/ref.ts
// Ref — mutable reference with atomic operations for concurrent fiber access.
//
// A Ref<A> holds a mutable value that can be safely read and modified
// from multiple fibers. All operations are synchronous (no scheduling overhead).

import { Async, asyncSync } from "../types/asyncEffect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Ref<A> = {
  /** Get the current value. */
  readonly get: () => Async<unknown, never, A>;
  /** Set a new value. */
  readonly set: (value: A) => Async<unknown, never, void>;
  /** Modify the value with a function and return the new value. */
  readonly update: (f: (current: A) => A) => Async<unknown, never, A>;
  /** Modify the value and return a derived result. */
  readonly modify: <B>(f: (current: A) => [B, A]) => Async<unknown, never, B>;
  /** Get the current value synchronously (for non-effect contexts). */
  readonly unsafeGet: () => A;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a mutable reference with an initial value.
 *
 * ```ts
 * const counter = makeRef(0);
 *
 * // In effects:
 * await run(counter.update(n => n + 1));
 * const value = await run(counter.get());
 *
 * // Synchronous access (outside effects):
 * counter.unsafeGet();
 * ```
 */
export function makeRef<A>(initial: A): Ref<A> {
  let value = initial;

  return {
    get: () => asyncSync(() => value),
    set: (v: A) => asyncSync(() => { value = v; }) as Async<unknown, never, void>,
    update: (f: (current: A) => A) => asyncSync(() => { value = f(value); return value; }),
    modify: <B>(f: (current: A) => [B, A]) => asyncSync(() => {
      const [result, next] = f(value);
      value = next;
      return result;
    }),
    unsafeGet: () => value,
  };
}

/**
 * Creates a derived Ref that applies a lens to a parent Ref.
 *
 * ```ts
 * const state = makeRef({ count: 0, name: "test" });
 * const countRef = derivedRef(state, s => s.count, (s, c) => ({ ...s, count: c }));
 * ```
 */
export function derivedRef<A, B>(
  parent: Ref<A>,
  get: (a: A) => B,
  set: (a: A, b: B) => A
): Ref<B> {
  return {
    get: () => asyncSync(() => get(parent.unsafeGet())),
    set: (b: B) => asyncSync(() => {
      const current = parent.unsafeGet();
      // Use parent's internal set via modify pattern
      (parent as any).set(set(current, b));
    }) as Async<unknown, never, void>,
    update: (f: (current: B) => B) => asyncSync(() => {
      const parentVal = parent.unsafeGet();
      const currentB = get(parentVal);
      const newB = f(currentB);
      // Trigger parent update
      const newParent = set(parentVal, newB);
      // Directly mutate parent (we know it's a makeRef)
      (parent as any).unsafeGet = () => newParent;
      return newB;
    }),
    modify: <C>(f: (current: B) => [C, B]) => asyncSync(() => {
      const parentVal = parent.unsafeGet();
      const currentB = get(parentVal);
      const [result, newB] = f(currentB);
      const newParent = set(parentVal, newB);
      (parent as any).unsafeGet = () => newParent;
      return result;
    }),
    unsafeGet: () => get(parent.unsafeGet()),
  };
}
