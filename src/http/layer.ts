import { asyncSync, type Async } from "../core/types/asyncEffect";
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
} from "./defaultClient";

export const HttpClientService = makeServiceTag<DefaultHttpClient>("HttpClient");

export type DefaultHttpClientLayerConfig =
  | DefaultHttpClientConfig
  | ((context: LayerContext) => DefaultHttpClientConfig);

export type DefaultHttpClientLayerOptions = {
  readonly tag?: ServiceTag<DefaultHttpClient>;
};

export function makeDefaultHttpClientLayer(
  config: DefaultHttpClientLayerConfig = {},
  options: DefaultHttpClientLayerOptions = {},
): Layer<LayerContext, unknown, LayerContext> {
  const tag = options.tag ?? HttpClientService;

  return layerEffect(
    tag,
    (context) =>
      asyncSync(() =>
        makeDefaultHttpClient(resolveDefaultHttpClientLayerConfig(config, context))
      ) as Async<unknown, unknown, DefaultHttpClient>,
    shutdownDefaultHttpClient,
  );
}

function resolveDefaultHttpClientLayerConfig(
  config: DefaultHttpClientLayerConfig,
  context: LayerContext,
): DefaultHttpClientConfig {
  return typeof config === "function" ? config(context) : config;
}

function shutdownDefaultHttpClient(client: DefaultHttpClient): Async<unknown, never, void> {
  return client.shutdown();
}
