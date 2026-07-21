import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { async, asyncSync } from "../../types/asyncEffect";
import type { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";
import { Scope } from "../scope";
import type { RuntimeEngineMode } from "../engine/types";
import { resolveWasmModule } from "../wasmModule";

type HostLifecycleFixture = {
  readonly name: string;
  readonly owner: "typescript";
  readonly expectedFinalizerOrder: readonly string[];
  readonly expectedChildCancels: number;
  readonly expectedAsyncResumes: number;
  readonly expectedOrphans: number;
};

const fixtures = (JSON.parse(readFileSync(
  resolve(process.cwd(), "fixtures/native-lifecycle-v1.json"),
  "utf8",
)) as { hostLifecycle: readonly HostLifecycleFixture[] }).hostLifecycle;

const engines: RuntimeEngineMode[] = [
  "ts",
  ...(resolveWasmModule({ fresh: true }) === null ? [] : ["wasm" as const]),
];

describe("structured lifecycle parity from the shared corpus", () => {
  for (const engine of engines) {
    for (const fixture of fixtures) {
      it(`${engine}: ${fixture.name}`, async () => {
        expect(fixture.owner).toBe("typescript");
        const runtime = new Runtime({
          env: {},
          engine,
          scheduler: new Scheduler({ engine: "ts" }),
        });
        const parent = new Scope(runtime);
        const child = parent.subScope();
        const finalizers: string[] = [];
        let childCancels = 0;
        let asyncResumes = 0;

        parent.addFinalizer(() => asyncSync(() => finalizers.push("parent")));
        child.addFinalizer(() => asyncSync(() => finalizers.push("child")));

        const resumed = child.fork(async((_env, callback) => {
          queueMicrotask(() => {
            asyncResumes += 1;
            callback({ _tag: "Success", value: "resumed" });
          });
          return () => undefined;
        }));
        await join(resumed);

        const blocked = child.fork(async(() => () => {
          childCancels += 1;
        }));
        await new Promise((resolveReady) => setTimeout(resolveReady, 0));

        await runtime.toPromise(parent.closeAsync());
        const blockedExit = await join(blocked);
        expect(blockedExit).toMatchObject({
          _tag: "Failure",
          cause: { _tag: "Interrupt" },
        });

        expect(finalizers).toEqual(fixture.expectedFinalizerOrder);
        expect(childCancels).toBe(fixture.expectedChildCancels);
        expect(asyncResumes).toBe(fixture.expectedAsyncResumes);
        const diagnostics = runtime.diagnostics();
        expect(diagnostics.fibers).toMatchObject({
          live: fixture.expectedOrphans,
          running: 0,
          suspended: 0,
          queued: 0,
          pendingHostEffects: 0,
        });
        expect(diagnostics.scopes).toMatchObject({ pending: 0, pendingFinalizers: 0 });
        await runtime.shutdown();
      });
    }
  }
});

function join<E, A>(fiber: { join(callback: (exit: Exit<E, A>) => void): void }): Promise<Exit<E, A>> {
  return new Promise((resolveExit) => fiber.join(resolveExit));
}
