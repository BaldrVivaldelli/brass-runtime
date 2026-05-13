import { asyncSync, type Async } from "../types/asyncEffect";
import { Runtime, type RuntimeOptions } from "./runtime";
import {
  layerEffect,
  makeServiceTag,
  type Layer,
  type LayerContext,
  type ServiceTag,
} from "./layer";

export const RuntimeService = makeServiceTag<Runtime<any>>("Runtime");

export type RuntimeLayerEnv<R extends object> =
  | R
  | ((context: LayerContext) => R);

export type RuntimeLayerOptions<R extends object> =
  Omit<RuntimeOptions<R>, "env"> & {
    readonly tag?: ServiceTag<Runtime<R>>;
  };

export function makeRuntimeLayer<R extends object = {}>(
  env: RuntimeLayerEnv<R> = {} as R,
  options: RuntimeLayerOptions<R> = {},
): Layer<LayerContext, unknown, LayerContext> {
  const { tag = RuntimeService as ServiceTag<Runtime<R>>, ...runtimeOptions } = options;

  return layerEffect(
    tag,
    (context) =>
      asyncSync(() =>
        new Runtime({
          ...runtimeOptions,
          env: resolveRuntimeLayerEnv(env, context),
        })
      ) as Async<unknown, unknown, Runtime<R>>,
  );
}

function resolveRuntimeLayerEnv<R extends object>(
  env: RuntimeLayerEnv<R>,
  context: LayerContext,
): R {
  return typeof env === "function" ? env(context) : env;
}
