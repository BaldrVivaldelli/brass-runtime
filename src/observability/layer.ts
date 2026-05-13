import { asyncSync, type Async } from "../core/types/asyncEffect";
import { fromPromiseAbortable, Runtime, type RuntimeOptions } from "../core/runtime/runtime";
import { RuntimeService } from "../core/runtime/runtimeLayer";
import {
  layerEffect,
  makeServiceTag,
  type Layer,
  type LayerContext,
  type ServiceTag,
} from "../core/runtime/layer";
import {
  makeDefaultHttpClient,
  type DefaultHttpClient,
  type DefaultHttpClientConfig,
} from "../http/defaultClient";
import { HttpClientService } from "../http/layer";
import { withHttpObservability, type HttpObservabilityOptions } from "./http";
import {
  makeObservability,
  type Observability,
  type ObservabilityOptions,
  type ObservabilityRuntimeEnv,
} from "./setup";

export const ObservabilityService = makeServiceTag<Observability>("Observability");

export type ObservabilityLayerConfig =
  | ObservabilityOptions
  | ((context: LayerContext) => ObservabilityOptions);

export type ObservabilityLayerOptions = {
  readonly tag?: ServiceTag<Observability>;
};

export type ObservedHttpClientLayerConfig =
  | DefaultHttpClientConfig
  | ((context: LayerContext, observability: Observability) => DefaultHttpClientConfig);

export type ObservedHttpClientLayerOptions = {
  readonly observabilityTag?: ServiceTag<Observability>;
  readonly httpTag?: ServiceTag<DefaultHttpClient>;
  readonly httpObservability?:
    | HttpObservabilityOptions
    | ((context: LayerContext, observability: Observability) => HttpObservabilityOptions);
};

export type ObservedRuntimeLayerEnv<R extends object> =
  | R
  | ((context: LayerContext, observability: Observability) => R);

export type ObservedRuntimeLayerOptions<R extends object> =
  Omit<RuntimeOptions<R & ObservabilityRuntimeEnv>, "env" | "hooks"> & {
    readonly observabilityTag?: ServiceTag<Observability>;
    readonly runtimeTag?: ServiceTag<Runtime<R & ObservabilityRuntimeEnv>>;
    readonly env?: ObservedRuntimeLayerEnv<R>;
  };

export function makeObservabilityLayer(
  config: ObservabilityLayerConfig = {},
  options: ObservabilityLayerOptions = {},
): Layer<LayerContext, unknown, LayerContext> {
  const tag = options.tag ?? ObservabilityService;

  return layerEffect(
    tag,
    (context) =>
      asyncSync(() => makeObservability(resolveObservabilityLayerConfig(config, context))) as Async<unknown, unknown, Observability>,
    shutdownObservability,
  );
}

export function makeObservedRuntimeLayer<R extends object = {}>(
  options: ObservedRuntimeLayerOptions<R> = {},
): Layer<LayerContext, unknown, LayerContext> {
  const {
    observabilityTag = ObservabilityService,
    runtimeTag = RuntimeService as ServiceTag<Runtime<R & ObservabilityRuntimeEnv>>,
    env = {} as R,
    ...runtimeOptions
  } = options;

  return layerEffect(
    runtimeTag,
    (context) =>
      asyncSync(() => {
        const observability = context.unsafeGet(observabilityTag);
        return new Runtime({
          ...runtimeOptions,
          env: mergeRuntimeEnv(resolveObservedRuntimeLayerEnv(env, context, observability), observability.env),
          hooks: observability.hooks,
        });
      }) as Async<unknown, unknown, Runtime<R & ObservabilityRuntimeEnv>>,
  );
}

export function makeObservedHttpClientLayer(
  config: ObservedHttpClientLayerConfig = {},
  options: ObservedHttpClientLayerOptions = {},
): Layer<LayerContext, unknown, LayerContext> {
  const observabilityTag = options.observabilityTag ?? ObservabilityService;
  const httpTag = options.httpTag ?? HttpClientService;

  return layerEffect(
    httpTag,
    (context) =>
      asyncSync(() => {
        const observability = context.unsafeGet(observabilityTag);
        const httpConfig = resolveObservedHttpClientLayerConfig(config, context, observability);
        const httpObservability = resolveObservedHttpObservabilityOptions(
          options.httpObservability,
          context,
          observability,
        );

        return makeDefaultHttpClient({
          ...httpConfig,
          middleware: [
            ...(httpConfig.middleware ?? []),
            withHttpObservability({
              metrics: observability.metrics,
              ...httpObservability,
            }),
          ],
        });
      }) as Async<unknown, unknown, DefaultHttpClient>,
    shutdownDefaultHttpClient,
  );
}

function resolveObservabilityLayerConfig(
  config: ObservabilityLayerConfig,
  context: LayerContext,
): ObservabilityOptions {
  return typeof config === "function" ? config(context) : config;
}

function resolveObservedHttpClientLayerConfig(
  config: ObservedHttpClientLayerConfig,
  context: LayerContext,
  observability: Observability,
): DefaultHttpClientConfig {
  return typeof config === "function" ? config(context, observability) : config;
}

function resolveObservedHttpObservabilityOptions(
  options: ObservedHttpClientLayerOptions["httpObservability"],
  context: LayerContext,
  observability: Observability,
): HttpObservabilityOptions {
  return typeof options === "function" ? options(context, observability) : options ?? {};
}

function resolveObservedRuntimeLayerEnv<R extends object>(
  env: ObservedRuntimeLayerEnv<R>,
  context: LayerContext,
  observability: Observability,
): R {
  return typeof env === "function" ? env(context, observability) : env;
}

function mergeRuntimeEnv<R extends object>(
  env: R,
  observabilityEnv: ObservabilityRuntimeEnv,
): R & ObservabilityRuntimeEnv {
  return Object.assign({}, env, observabilityEnv) as R & ObservabilityRuntimeEnv;
}

function shutdownObservability(observability: Observability): Async<unknown, never, void> {
  return fromPromiseAbortable<never, void>(
    () => observability.shutdown().then(() => undefined),
    () => undefined as never,
    { label: "observability.shutdown" },
  );
}

function shutdownDefaultHttpClient(client: DefaultHttpClient): Async<unknown, never, void> {
  return client.shutdown();
}
