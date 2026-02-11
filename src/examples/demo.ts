import type { Exit } from "../core/types/effect";
import { succeed } from "../core/types/effect";

import { collectStream, fromArray, mapStream } from "../core/stream/stream";
import { withScope } from "../core/runtime/scope";

import { asyncFlatMap, asyncSucceed, type Async } from "../core/types/asyncEffect";
import type { Interrupted } from "../core/runtime/fiber";
import { fromPromiseAbortable, Runtime } from "../core/runtime/runtime";

type Env = {};

// sleep abortable que falla con Interrupted
export function sleep(ms: number): Async<unknown, Interrupted, void> {
  return fromPromiseAbortable<Interrupted, void>(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, ms);

        const onAbort = () => {
          clearTimeout(id);
          reject({ _tag: "Interrupted" } satisfies Interrupted);
        };

        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    (e) =>
      typeof e === "object" && e !== null && (e as any)._tag === "Interrupted"
        ? (e as Interrupted)
        : ({ _tag: "Interrupted" } as Interrupted)
  );
}

function task(name: string, ms: number): Async<unknown, Interrupted, string> {
  return asyncFlatMap(sleep(ms), () => asyncSucceed(`Terminé ${name} después de ${ms}ms`));
}

// Helper: corre un efecto y loguea su Exit (incluyendo Interrupted)
function run<E, A>(runtime: Runtime<Env>, label: string, eff: Async<Env, E, A>) {
  const f = runtime.fork(eff);
  f.join((exit: Exit<E | Interrupted, A>) => {
    console.log(label, exit);
  });
  return f;
}

function main() {
  const env: Env = {};

  // ✅ tu Runtime espera { env: R; ... }
  const runtime: Runtime<Env> = new Runtime<Env>({ env });

  // Root fibers (NO scoped)
  console.log("== root fibers (not scoped) ==");
  const rootA = run(runtime, "root A:", task("A", 1000));
  const rootB = run(runtime, "root B:", task("B", 500));

  // “zip” demo
  const eff1 = succeed(10);
  const eff2 = succeed(20);
  const sumEff: Async<Env, never, [number, number]> = asyncFlatMap(
    eff1 as any,
    (a: number) => asyncFlatMap(eff2 as any, (b: number) => asyncSucceed([a, b] as [number, number]))
  );
  run(runtime, "zip(eff1, eff2):", sumEff as any);

  // foreach demo
  const nums = [1, 2, 3];
  const foreachEff: Async<Env, never, number[]> = nums.reduce(
    (accEff, n) =>
      asyncFlatMap(accEff as any, (acc: number[]) =>
        asyncFlatMap(succeed(n * 2) as any, (m: number) => asyncSucceed([...acc, m]))
      ),
    asyncSucceed([] as number[])
  );
  run(runtime, "foreach array:", foreachEff as any);

  // Stream map + collect demo
  const s = fromArray([1, 2, 3, 4]);
  const sMapped = mapStream(s, (n) => n * 10);
  run(runtime, "Stream mapeado:", collectStream(sMapped) as any);

  // Scoped fibers (SE interrumpen)
  console.log("== scoped fibers (will be interrupted) ==");
  withScope(runtime, (scope) => {
    const f1 = scope.fork(task("A", 1000));
    const f2 = scope.fork(task("B", 1500));
    const f3 = scope.fork(task("C", 2000));

    console.log("Tareas lanzadas dentro del scope");

    setTimeout(() => {
      console.log("CANCELANDO TODO EL SCOPE...");
      scope.close();
    }, 300);

    f1.join((ex) => console.log("scope f1:", ex));
    f2.join((ex) => console.log("scope f2:", ex));
    f3.join((ex) => console.log("scope f3:", ex));
  });

  // opcional: para que el proceso no termine “antes” en algunos runners
  rootA.join(() => {});
  rootB.join(() => {});
}

main();
