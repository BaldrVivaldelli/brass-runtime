import { describe, expect, it } from "vitest";
import { Effect, pipe, runPromise, runExit } from "../next";

describe("v2 composition DX", () => {
  it("replaces nested flatMap with gen", async () => {
    const program = Effect.gen(function* ($) {
      const left = yield* $(Effect.succeed(20));
      const right = yield* $(Effect.succeed(22));
      return left + right;
    });

    await expect(runPromise(program)).resolves.toBe(42);
  });

  it("supports data-last combinators inside pipe", async () => {
    const program = pipe(
      Effect.succeed(20),
      Effect.map((n: number) => n + 22),
      Effect.tap(() => Effect.succeed(undefined)),
      Effect.as("done"),
    );

    await expect(runPromise(program)).resolves.toBe("done");
  });

  it("keeps the data-first calling convention working", async () => {
    const program = Effect.map(Effect.succeed(20), (n) => n + 22);
    await expect(runPromise(program)).resolves.toBe(42);
  });

  it("recovers from a typed failure in a pipeline", async () => {
    const program = pipe(
      Effect.fail("boom" as const),
      Effect.catchAllWith((e: "boom") => `recovered:${e}`),
    );

    await expect(runPromise(program)).resolves.toBe("recovered:boom");
  });

  it("disambiguates retryWithBackoff between its two arities", async () => {
    const dataFirst = Effect.retryWithBackoff(Effect.succeed("ok"), { maxRetries: 1 });
    await expect(runPromise(dataFirst)).resolves.toBe("ok");

    const dataLast = pipe(Effect.succeed("ok"), Effect.retryWithBackoff({ maxRetries: 1 }));
    await expect(runPromise(dataLast)).resolves.toBe("ok");

    const noOptions = pipe(Effect.succeed("ok"), Effect.retryWithBackoff());
    await expect(runPromise(noOptions)).resolves.toBe("ok");
  });

  it("propagates failures through gen without running later steps", async () => {
    let reached = false;
    const program = Effect.gen(function* ($) {
      yield* $(Effect.fail("stop"));
      reached = true;
      return "unreachable";
    });

    const exit = await runExit(program);
    expect(exit._tag).toBe("Failure");
    expect(reached).toBe(false);
  });
});
