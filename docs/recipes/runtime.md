# Runtime Recipe

Use `runPromise` for the short path and `runExit` when you want the complete
`Exit`/`Cause` value.

```ts
import { asyncFlatMap, asyncSucceed, runExit, runPromise } from "brass-runtime";

const program = asyncFlatMap(asyncSucceed(41), (n) => asyncSucceed(n + 1));

const value = await runPromise(program);
const exit = await runExit(program);

console.log(value); // 42
console.log(exit);
```

Use `makeRuntime` when the app owns runtime configuration.

```ts
import { makeRuntime, asyncSync } from "brass-runtime";

const runtime = makeRuntime({ config: { port: 3000 } }, { inferLane: false });

const port = await runtime.toPromise(
  asyncSync((env: { config: { port: number } }) => env.config.port),
);
```

If you care about typed failures, prefer `runExit` at the boundary and format
the cause in logs or HTTP responses.

```ts
import { Cause, asyncFail, runExit } from "brass-runtime";

const exit = await runExit(asyncFail({ _tag: "NotFound", id: "u1" }));

if (exit._tag === "Failure") {
  console.error(Cause.pretty(exit.cause));
}
```
