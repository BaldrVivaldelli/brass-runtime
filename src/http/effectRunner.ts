import type { Async } from "../core/types/asyncEffect";
import type { Exit } from "../core/types/effect";
import { Cause } from "../core/types/effect";

export type EffectCanceler = () => void;

export function registerHttpEffect<E, A>(
  effect: Async<unknown, E, A>,
  env: unknown,
  cb: (exit: Exit<E, A>) => void,
): EffectCanceler {
  let done = false;
  let currentCancel: EffectCanceler | undefined;

  const finish = (exit: Exit<E, A>) => {
    if (done) return;
    done = true;
    currentCancel = undefined;
    cb(exit);
  };

  const run = <E2, A2>(
    current: Async<unknown, E2, A2>,
    cont: (exit: Exit<E2, A2>) => void,
  ): void => {
    if (done) return;

    switch (current._tag) {
      case "Succeed":
        cont({ _tag: "Success", value: current.value });
        return;
      case "Fail":
        cont({ _tag: "Failure", cause: Cause.fail(current.error) });
        return;
      case "Sync":
        try {
          cont({ _tag: "Success", value: current.thunk(env) });
        } catch (e) {
          cont({ _tag: "Failure", cause: Cause.die(e) as any });
        }
        return;
      case "Async": {
        const cancel = current.register(env, (exit) => {
          currentCancel = undefined;
          if (done) return;
          cont(exit);
        });
        currentCancel = typeof cancel === "function" ? cancel : undefined;
        return;
      }
      case "FlatMap":
        run(current.first, (exit) => {
          if (done) return;
          if (exit._tag === "Failure") {
            cont(exit as any);
            return;
          }
          try {
            run(current.andThen(exit.value), cont as any);
          } catch (e) {
            cont({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        });
        return;
      case "Fold":
        run(current.first, (exit) => {
          if (done) return;
          try {
            if (exit._tag === "Success") {
              run(current.onSuccess(exit.value), cont as any);
              return;
            }
            if (exit.cause._tag === "Fail") {
              run(current.onFailure(exit.cause.error), cont as any);
              return;
            }
            cont(exit as any);
          } catch (e) {
            cont({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        });
        return;
      case "Fork":
        cont({ _tag: "Success", value: undefined as any });
        return;
    }
  };

  run(effect, finish);

  return () => {
    if (done) return;
    const cancel = currentCancel;
    currentCancel = undefined;
    done = true;
    try {
      cancel?.();
    } finally {
      cb({ _tag: "Failure", cause: Cause.interrupt() });
    }
  };
}
