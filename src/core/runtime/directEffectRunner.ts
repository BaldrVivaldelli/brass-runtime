import type { Async } from "../types/asyncEffect";
import { Cause, type Exit } from "../types/effect";
import { Runtime } from "./runtime";

export type EffectCanceler = () => void;

type DirectContinuation =
  | {
      readonly _tag: "Success";
      readonly andThen: (value: unknown) => Async<unknown, unknown, unknown>;
    }
  | {
      readonly _tag: "Fold";
      readonly onFailure: (error: unknown) => Async<unknown, unknown, unknown>;
      readonly onSuccess: (value: unknown) => Async<unknown, unknown, unknown>;
    };

const DIRECT_EFFECT_STEP_BUDGET = 2_048;

/**
 * Runs the small Effect ADT directly for latency-sensitive adapters.
 *
 * Pure composition is interpreted with an explicit continuation stack and a
 * microtask budget. Runtime-owned nodes are delegated to a real Runtime so
 * fork, interruptibility, and FiberRef semantics are never approximated.
 * Application code should still use Runtime directly.
 */
export function registerEffectDirect<E, A>(
  effect: Async<unknown, E, A>,
  env: unknown,
  cb: (exit: Exit<E, A>) => void,
): EffectCanceler {
  const stack: DirectContinuation[] = [];
  let current = effect as Async<unknown, unknown, unknown>;
  let done = false;
  let running = false;
  let scheduled = false;
  let cancelRequested = false;
  let currentCancel: EffectCanceler | undefined;
  let currentCancelOwnsCompletion = false;
  let currentOwner: symbol | undefined;

  const finish = (exit: Exit<unknown, unknown>) => {
    if (done) return;
    done = true;
    currentCancel = undefined;
    currentCancelOwnsCompletion = false;
    currentOwner = undefined;
    cb(exit as Exit<E, A>);
  };

  const continueFailure = (initialCause: Cause<unknown>) => {
    let cause = initialCause;

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame._tag !== "Fold" || !Cause.isFailureOnly(cause)) continue;

      const failure = Cause.firstFailure(cause);
      if (failure._tag === "None") continue;

      try {
        current = frame.onFailure(failure.value);
        return;
      } catch (error) {
        cause = Cause.die(error);
      }
    }

    finish({ _tag: "Failure", cause });
  };

  const continueSuccess = (initialValue: unknown) => {
    let value = initialValue;

    while (stack.length > 0) {
      const frame = stack.pop()!;
      try {
        current = frame._tag === "Success"
          ? frame.andThen(value)
          : frame.onSuccess(value);
        return;
      } catch (error) {
        continueFailure(Cause.die(error));
        return;
      }
    }

    finish({ _tag: "Success", value });
  };

  const consumeExit = (exit: Exit<unknown, unknown>) => {
    if (exit._tag === "Success") continueSuccess(exit.value);
    else continueFailure(exit.cause);
  };

  const scheduleDrive = () => {
    if (done || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      drive();
    });
  };

  const runWithRuntime = (node: Async<unknown, unknown, unknown>) => {
    const owner = Symbol("direct-effect-runtime");

    try {
      const runtime = Runtime.make(env);
      const fiber = runtime.fork(node);
      currentOwner = owner;
      currentCancelOwnsCompletion = true;
      currentCancel = () => fiber.interrupt();
      fiber.join((exit) => {
        if (done) return;
        if (currentOwner === owner) {
          currentOwner = undefined;
          currentCancel = undefined;
          currentCancelOwnsCompletion = false;
        }
        consumeExit(exit);
        drive();
      });
    } catch (error) {
      currentOwner = undefined;
      currentCancel = undefined;
      currentCancelOwnsCompletion = false;
      continueFailure(Cause.die(error));
      scheduleDrive();
    }
  };

  const drive = () => {
    if (done || running) return;
    running = true;
    let exhaustedBudget = false;

    try {
      let budget = DIRECT_EFFECT_STEP_BUDGET;
      while (!done && budget-- > 0) {
        switch (current._tag) {
          case "Succeed":
            continueSuccess(current.value);
            break;
          case "Fail":
            continueFailure(Cause.fail(current.error));
            break;
          case "Sync":
            try {
              continueSuccess(current.thunk(env));
            } catch (error) {
              continueFailure(Cause.die(error));
            }
            break;
          case "Async": {
            const owner = Symbol("direct-effect-async");
            let registered = false;
            let settled = false;
            let syncExit: Exit<unknown, unknown> | undefined;
            let cancel: void | EffectCanceler;

            const resume = (exit: Exit<unknown, unknown>) => {
              if (settled) return;
              settled = true;
              if (!registered) {
                syncExit = exit;
                return;
              }
              if (done) return;
              if (currentOwner === owner) {
                currentOwner = undefined;
                currentCancel = undefined;
                currentCancelOwnsCompletion = false;
              }
              consumeExit(exit);
              drive();
            };

            try {
              cancel = current.register(env, resume);
            } catch (error) {
              registered = true;
              if (syncExit) consumeExit(syncExit);
              else continueFailure(Cause.die(error));
              break;
            }

            registered = true;
            if (syncExit) {
              consumeExit(syncExit);
              break;
            }

            currentOwner = owner;
            currentCancel = typeof cancel === "function" ? cancel : undefined;
            currentCancelOwnsCompletion = false;
            return;
          }
          case "FlatMap":
            stack.push({
              _tag: "Success",
              andThen: current.andThen as (value: unknown) => Async<unknown, unknown, unknown>,
            });
            current = current.first;
            break;
          case "Fold":
            stack.push({
              _tag: "Fold",
              onFailure: current.onFailure,
              onSuccess: current.onSuccess,
            });
            current = current.first;
            break;
          case "Fork":
          case "Interruptibility":
          case "InterruptibilityRestore":
          case "FiberRefLocally":
            runWithRuntime(current);
            return;
          case "InterruptibilityMask":
            try {
              runWithRuntime({
                _tag: "Interruptibility",
                mode: "uninterruptible",
                effect: current.body((inner) => ({
                  _tag: "InterruptibilityRestore",
                  depth: 0,
                  effect: inner,
                })),
              });
              return;
            } catch (error) {
              continueFailure(Cause.die(error));
            }
            break;
        }
      }

      exhaustedBudget = !done;
    } finally {
      running = false;
    }

    if (exhaustedBudget) scheduleDrive();
  };

  drive();

  return () => {
    if (done || cancelRequested) return;
    cancelRequested = true;
    const cancel = currentCancel;
    const cancelOwnsCompletion = currentCancelOwnsCompletion;
    currentCancel = undefined;
    currentCancelOwnsCompletion = false;

    if (cancelOwnsCompletion) {
      try {
        cancel?.();
      } catch {
        finish({ _tag: "Failure", cause: Cause.interrupt() });
      }
      return;
    }

    done = true;
    currentOwner = undefined;
    try {
      cancel?.();
    } catch {
      // Cancellation is best-effort. The interrupt exit still owns completion.
    } finally {
      cb({ _tag: "Failure", cause: Cause.interrupt() });
    }
  };
}
