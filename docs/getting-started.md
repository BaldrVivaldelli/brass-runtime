# Getting started

`brass-runtime` is a cooperative, functional runtime for JavaScript and
TypeScript, inspired by ZIO, Effect, and structured concurrency. It lets you
write logic that is pure, cancelable, and composable without giving up the
ability to run it from ordinary imperative code.

## Install

```bash
npm install brass-runtime
```

## Key concepts

### `Async<R, E, A>`

An `Async` describes a lazy computation that:

- may require an environment (`R`)
- may fail with a typed error (`E`)
- may produce a value (`A`)
- **does not run on its own**

Nothing happens until you explicitly ask for it. Building an `Async` never
performs the side effect it describes.

### The mental model

```
Async  --->  Fiber  --->  Scheduler  --->  Result
  |            |             |
  |            |             +-- controls execution
  |            +-- holds state and cancellation
  +-- describes the computation
```

## Running an effect

`runPromise` is the bridge between the effect world and imperative code. It
interprets the effect on the runtime and resolves with its success value:

```ts
import { runPromise, succeed } from "brass-runtime";

const value = await runPromise(succeed(42));
```

Use `runExit` when you want the full `Exit`/`Cause` instead of a rejected
promise, and `makeRuntime` when you need explicit runtime options.

## Composing effects

For sequential work, `Effect.gen` keeps multi-step code flat:

```ts
import { Effect, runPromise } from "brass-runtime";

const program = Effect.gen(function* ($) {
  const user = yield* $(fetchUser(1));
  const orders = yield* $(fetchOrders(user.id));
  return { user, orders };
});

const result = await runPromise(program);
```

Each step is typed independently, environments accumulate as an intersection,
failures accumulate as a union, and the fiber stays interruptible between
steps.

For linear transformations, use `pipe`. Every combinator accepts both a
data-first and a data-last form:

```ts
import { Effect, pipe } from "brass-runtime";

const program = pipe(
  fetchUser(1),
  Effect.map((user) => user.name),
  Effect.catchAllWith(() => "anonymous"),
  Effect.timeout(1_000),
);
```

## An HTTP example

```ts
import { makeDefaultHttpClient, s } from "brass-runtime/http";

const Post = s.object({
  id: s.number({ int: true }),
  title: s.string({ minLength: 1 }),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

const post = await http.getJson("/posts/1", { schema: Post }).unsafeRunPromise();

console.log(post.status, post.body.title);
```

The response is validated against the schema at runtime, and `post.body` is
typed from it.

## Why not use `fetch` directly?

Because an `Async` gives you:

- structured cancellation that propagates through the whole call graph
- functional composition
- explicit control over when execution happens
- deterministic testing
- integration with fibers and scopes

## The golden rule

> **Effects do not run themselves.** They are described as `Async` values and
> only execute when handed to a runner such as `runPromise`.

## Testing

```ts
import { runPromise } from "brass-runtime";

test("fetches a post", async () => {
  const result = await runPromise(http.get("/posts/1"));
  expect(result.status).toBe(200);
});
```

## Next

- Learn how interruption and `Scope` work: [Cancellation & interruption](./cancellation.md)
- Enable logging and tracing with hooks: [Observability](./observability.md)
- Browse the HTTP workflows: [HTTP recipes](./http-recipes.md)
