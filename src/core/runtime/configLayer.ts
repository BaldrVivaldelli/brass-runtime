import { asyncSync, type Async } from "../types/asyncEffect";
import { parseConfig, type JsonSchemaLike } from "../../schema";
import {
  layerEffect,
  type Layer,
  type LayerContext,
  type ServiceTag,
} from "./layer";

export type ConfigLayerSource =
  | unknown
  | ((context: LayerContext) => unknown);

export type ConfigLayerOptions = {
  readonly name?: string;
};

export function makeConfigLayer<A>(
  tag: ServiceTag<A>,
  schema: JsonSchemaLike<A>,
  source: ConfigLayerSource,
  options: ConfigLayerOptions = {},
): Layer<LayerContext, unknown, LayerContext> {
  return layerEffect(
    tag,
    (context) =>
      asyncSync(() =>
        parseConfig(options.name ?? tag.name, schema, readConfigSource(source, context))
      ) as Async<unknown, unknown, A>,
  );
}

export const defineConfigLayer = makeConfigLayer;

function readConfigSource(source: ConfigLayerSource, context: LayerContext): unknown {
  return typeof source === "function"
    ? (source as (context: LayerContext) => unknown)(context)
    : source;
}
