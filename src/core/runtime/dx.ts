import type { Async } from "../types/asyncEffect";
import type { Exit } from "../types/effect";
import { Runtime, toPromise as toPromiseWithEnv, unsafeRunAsync, type RuntimeOptions } from "./runtime";

export type EffectSuccess<T> = T extends Async<any, any, infer A> ? A : never;
export type EffectFailure<T> = T extends Async<any, infer E, any> ? E : never;
export type EffectEnvironment<T> = T extends Async<infer R, any, any> ? R : never;

export type MakeRuntimeOptions<R> = Omit<RuntimeOptions<R>, "env">;

/**
 * Create a runtime with a compact options shape.
 *
 * This is an additive DX helper over `new Runtime({ env, ...options })`.
 */
export function makeRuntime<R extends object = {}>(
  env: R = {} as R,
  options: MakeRuntimeOptions<R> = {},
): Runtime<R> {
  return new Runtime({ ...options, env });
}

/**
 * Run an effect and resolve with its success value.
 *
 * Accepts either a plain environment or an existing Runtime. For advanced
 * lifecycle/hooks/scheduler behavior, pass the Runtime explicitly.
 */
export function runPromise<R, E, A>(
  effect: Async<R, E, A>,
  envOrRuntime?: R | Runtime<R>,
): Promise<A> {
  if (envOrRuntime instanceof Runtime) return envOrRuntime.toPromise(effect);
  return toPromiseWithEnv(effect, envOrRuntime);
}

/**
 * Run an effect and resolve with the full Exit, preserving typed failures and
 * Cause structure instead of throwing/rejecting.
 */
export function runExit<R, E, A>(
  effect: Async<R, E, A>,
  envOrRuntime?: R | Runtime<R>,
): Promise<Exit<E, A>> {
  return new Promise((resolve) => {
    if (envOrRuntime instanceof Runtime) {
      envOrRuntime.unsafeRunAsync(effect, resolve);
      return;
    }
    unsafeRunAsync(effect, envOrRuntime, resolve);
  });
}

export const runEffect = runPromise;
