import { asyncFlatMap, asyncSync, type Async } from "../types/asyncEffect";
import { emptyContext } from "./contex";
import { getCurrentFiber } from "./fiber";

export type FiberRef<A> = {
  readonly id: number;
  readonly initial: A;
  readonly get: () => Async<unknown, never, A>;
  readonly set: (value: A) => Async<unknown, never, void>;
  readonly update: (f: (current: A) => A) => Async<unknown, never, A>;
  readonly modify: <B>(f: (current: A) => [B, A]) => Async<unknown, never, B>;
  readonly locally: <R, E, B>(value: A, effect: Async<R, E, B>) => Async<R, E, B>;
  readonly locallyWith: <R, E, B>(f: (current: A) => A, effect: Async<R, E, B>) => Async<R, E, B>;
  readonly unsafeGet: () => A;
  readonly unsafeSet: (value: A) => void;
};

let nextFiberRefId = 1;

export function makeFiberRef<A>(initial: A): FiberRef<A> {
  const ref: FiberRef<A> = {
    id: nextFiberRefId++,
    initial,
    get: () => getFiberRef(ref),
    set: (value) => setFiberRef(ref, value),
    update: (f) => updateFiberRef(ref, f),
    modify: (f) => modifyFiberRef(ref, f),
    locally: (value, effect) => locallyFiberRef(ref, value, effect),
    locallyWith: (f, effect) => locallyFiberRefWith(ref, f, effect),
    unsafeGet: () => unsafeGetFiberRef(ref),
    unsafeSet: (value) => unsafeSetFiberRef(ref, value),
  };
  return ref;
}

export function getFiberRef<A>(ref: FiberRef<A>): Async<unknown, never, A> {
  return asyncSync(() => unsafeGetFiberRef(ref)) as Async<unknown, never, A>;
}

export function setFiberRef<A>(ref: FiberRef<A>, value: A): Async<unknown, never, void> {
  return asyncSync(() => {
    unsafeSetFiberRef(ref, value);
  }) as Async<unknown, never, void>;
}

export function updateFiberRef<A>(ref: FiberRef<A>, f: (current: A) => A): Async<unknown, never, A> {
  return asyncSync(() => {
    const next = f(unsafeGetFiberRef(ref));
    unsafeSetFiberRef(ref, next);
    return next;
  }) as Async<unknown, never, A>;
}

export function modifyFiberRef<A, B>(ref: FiberRef<A>, f: (current: A) => [B, A]): Async<unknown, never, B> {
  return asyncSync(() => {
    const [result, next] = f(unsafeGetFiberRef(ref));
    unsafeSetFiberRef(ref, next);
    return result;
  }) as Async<unknown, never, B>;
}

export function locallyFiberRef<R, E, A, B>(
  ref: FiberRef<A>,
  value: A,
  effect: Async<R, E, B>,
): Async<R, E, B> {
  return {
    _tag: "FiberRefLocally",
    refId: ref.id,
    value,
    effect,
  };
}

export function locallyFiberRefWith<R, E, A, B>(
  ref: FiberRef<A>,
  f: (current: A) => A,
  effect: Async<R, E, B>,
): Async<R, E, B> {
  return asyncFlatMap(getFiberRef(ref), (value) => locallyFiberRef(ref, f(value), effect)) as Async<R, E, B>;
}

export function unsafeGetFiberRef<A>(ref: FiberRef<A>): A {
  const refs = currentFiberRefs(false);
  return refs?.has(ref.id) ? refs.get(ref.id) as A : ref.initial;
}

export function unsafeSetFiberRef<A>(ref: FiberRef<A>, value: A): void {
  const refs = currentFiberRefs(true);
  refs?.set(ref.id, value);
}

export function fiberRefSnapshot(): ReadonlyMap<number, unknown> {
  return new Map(currentFiberRefs(false));
}

function currentFiberRefs(create: boolean): Map<number, unknown> | undefined {
  const fiber = getCurrentFiber() as any;
  if (!fiber) return undefined;
  fiber.fiberContext ??= { log: emptyContext, trace: null };
  if (!fiber.fiberContext.fiberRefs && create) fiber.fiberContext.fiberRefs = new Map<number, unknown>();
  return fiber.fiberContext.fiberRefs;
}
