import { describe, expect, it } from "vitest";

import {
  Effect,
  Layer,
  Pipeline,
  Resource,
  Schedule,
  Stream,
  runPromise,
} from "../next";

const EXPECTED_EFFECT_OPERATIONS = [
  "as",
  "async",
  "catchAll",
  "catchAllWith",
  "fail",
  "flatMap",
  "fromPromiseAbortable",
  "gen",
  "interruptible",
  "map",
  "mapError",
  "retry",
  "retryN",
  "retryWithBackoff",
  "sleep",
  "succeed",
  "suspend",
  "sync",
  "tap",
  "timeout",
  "uninterruptible",
  "uninterruptibleMask",
] as const;

describe("v2 API preview", () => {
  it("keeps the Effect namespace small, frozen, and executable", async () => {
    expect(Object.isFrozen(Effect)).toBe(true);
    expect(Object.keys(Effect).sort()).toEqual(EXPECTED_EFFECT_OPERATIONS);

    const effect = Effect.gen(function* ($) {
      const value = yield* $(Effect.succeed(20));
      const other = yield* $(Effect.succeed(22));
      return value + other;
    });

    await expect(runPromise(effect)).resolves.toBe(42);
  });

  it("exposes discoverable frozen domain namespaces", () => {
    for (const namespace of [Layer, Pipeline, Resource, Schedule, Stream]) {
      expect(Object.isFrozen(namespace)).toBe(true);
    }
  });
});
