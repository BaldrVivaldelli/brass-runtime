import {
  Effect,
  type Effect as EffectType,
  runPromise,
} from "./next";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

const numberEffect = Effect.flatMap(
  Effect.succeed(20),
  (left) => Effect.map(Effect.succeed(22), (right) => left + right),
);

const typedEffect: EffectType<unknown, never, number> = numberEffect;
const result = runPromise(numberEffect);
type _PromiseInference = Assert<Equal<typeof result, Promise<number>>>;

void typedEffect;
void result;
