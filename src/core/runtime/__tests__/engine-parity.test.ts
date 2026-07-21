import { describe, expect, it } from "vitest";
import {
  async,
  asyncFail,
  asyncFlatMap,
  asyncFold,
  asyncMap,
  asyncSucceed,
  asyncSync,
  type Async,
} from "../../types/asyncEffect";
import type { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";
import type { RuntimeEngineMode } from "../engine/types";

const candidateModes: RuntimeEngineMode[] = ["wasm"];

function supportedParityModes(): RuntimeEngineMode[] {
  return candidateModes.filter((engine) => {
    try {
      const rt = Runtime.makeWithEngine({}, engine, { scheduler: new Scheduler({ engine: "ts" }) });
      void rt.stats();
      rt.shutdown();
      return true;
    } catch {
      return false;
    }
  });
}

function runToExit<A>(engine: RuntimeEngineMode, effect: Async<unknown, unknown, A>): Promise<Exit<unknown, A>> {
  return new Promise((resolve) => {
    const rt = Runtime.makeWithEngine({}, engine, { scheduler: new Scheduler({ engine: "ts" }) });
    rt.unsafeRunAsync(effect, (exit) => {
      rt.shutdown();
      resolve(exit);
    });
  });
}

function expectSameExit(actual: Exit<unknown, unknown>, expected: Exit<unknown, unknown>) {
  expect(actual).toEqual(expected);
}

type Case = {
  readonly name: string;
  readonly effect: Async<unknown, unknown, unknown>;
};

const cases: Case[] = [
  {
    name: "succeed",
    effect: asyncSucceed({ ok: true, n: 1 }),
  },
  {
    name: "fail",
    effect: asyncFail({ code: "boom" }),
  },
  {
    name: "sync",
    effect: asyncSync(() => 41 + 1),
  },
  {
    name: "flatMap chain",
    effect: asyncFlatMap(asyncSucceed(10), (n) =>
      asyncFlatMap(asyncSucceed(n + 1), (m) => asyncSucceed(m * 2)),
    ),
  },
  {
    name: "fold recovers failure",
    effect: asyncFold(
      asyncFail("bad"),
      (error) => asyncSucceed(`recovered:${error}`),
      (value) => asyncSucceed(value),
    ),
  },
  {
    name: "fold maps success",
    effect: asyncFold(
      asyncSucceed("ok"),
      (error) => asyncSucceed(`bad:${error}`),
      (value) => asyncSucceed(`${value}:mapped`),
    ),
  },
  {
    name: "sync exception becomes failure",
    effect: asyncFold(
      asyncSync(() => {
        throw new Error("sync-error");
      }),
      (error) => asyncSucceed(error instanceof Error ? error.message : String(error)),
      () => asyncSucceed("unexpected"),
    ),
  },
  {
    name: "synchronous async callback",
    effect: async((_env, cb) => {
      cb({ _tag: "Success", value: "inline" });
    }),
  },
  {
    name: "deferred async callback",
    effect: async((_env, cb) => {
      const handle = setTimeout(() => cb({ _tag: "Success", value: "later" }), 0);
      return () => clearTimeout(handle);
    }),
  },
  {
    name: "map over async",
    effect: asyncMap(
      async((_env, cb) => cb({ _tag: "Success", value: 5 })),
      (n) => n * 3,
    ),
  },
];

describe("Runtime engine parity", () => {
  for (const engine of supportedParityModes()) {
    describe(`${engine} vs ts`, () => {
      for (const testCase of cases) {
        it(`matches JS exit for ${testCase.name}`, async () => {
          const expected = await runToExit("ts", testCase.effect);
          const actual = await runToExit(engine, testCase.effect);
          expectSameExit(actual, expected);
        });
      }
    });
  }

  it("default runtime uses strict TS mode", async () => {
    const rt = Runtime.make({});
    await expect(rt.toPromise(asyncSucceed("ok"))).resolves.toBe("ok");
    expect(rt.engineMode).toBe("ts");
    expect(rt.stats().fallbackUsed).toBe(false);
    rt.shutdown();
  });

  it("uses an explicit, observable TS fallback only in auto mode", async () => {
    const events: unknown[] = [];
    let now = 10;
    const rt = new Runtime({
      env: {},
      engine: "auto",
      wasm: {
        modulePath: "/definitely-missing/brass-engine.wasm.js",
        boundaryDiagnostics: {
          sink: { emit: (event) => events.push(event) },
          correlationId: () => "engine-selection",
          now: () => now++,
        },
      },
    });

    await expect(rt.toPromise(asyncSucceed("fallback-ok"))).resolves.toBe("fallback-ok");
    expect(rt.engineMode).toBe("auto");
    expect(rt.stats()).toMatchObject({ engine: "ts", fallbackUsed: true });
    expect(rt.diagnostics()).toMatchObject({
      engine: "ts",
      requestedEngine: "auto",
      fallbackUsed: true,
      fallbackCode: "WASM_UNAVAILABLE",
    });
    expect(events).toEqual([
      expect.objectContaining({
        version: 1,
        boundary: "ts-wasm",
        operation: "engine.initialize",
        result: "fallback",
        correlationId: "engine-selection",
        errorCode: "WASM_UNAVAILABLE",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("definitely-missing");

    expect(() => new Runtime({
      env: {},
      engine: "wasm",
      wasm: { modulePath: "/definitely-missing/brass-engine.wasm.js" },
    })).toThrow(/could not load/i);
  });

  it("rejects unsupported engine modes at startup", () => {
    expect(() => new Runtime({ env: {}, engine: "wasm-reference" as any })).toThrow(/ts.*wasm|wasm.*ts|enum/i);
    expect(() => new Runtime({ env: {}, engine: "js" as any })).toThrow(/ts.*wasm|wasm.*ts|enum/i);
  });
});
