import {
  Effect,
  Stream,
  makeRuntime,
  runPromise,
} from "brass-runtime/next";

const answer = Effect.flatMap(
  Effect.succeed(20),
  (left) => Effect.map(Effect.succeed(22), (right) => left + right),
);

const values = Stream
  .range(1, 5)
  .map((value) => value * 2)
  .filter((value) => value > 5);

console.log("effect", await runPromise(answer));
console.log("stream", await values.collect(makeRuntime()));
