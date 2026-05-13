import {
  asyncSucceed,
  type Async,
} from "../types/asyncEffect";
import type { Exit } from "../types/effect";
import {
  Layer,
  composeAll,
  defineService,
  getService,
  getServices,
  layerValue,
  provide,
  provideContext,
  useServices,
  type LayerContext,
  type MissingLayerServiceError,
  type ServicesOf,
} from "./layer";
import {
  makeRuntime,
  runExit,
  runPromise,
} from "./dx";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Expect<T extends true> = T;

const Config = defineService<{ readonly port: number }>("Config");
const ConfigLayer = layerValue(Config, { port: 3000 });

const serviceEffect = getService(Config);
type _serviceEffect = Expect<Equal<typeof serviceEffect, Async<LayerContext, MissingLayerServiceError, { readonly port: number }>>>;

const servicesEffect = getServices({ config: Config });
type _servicesEffect = Expect<Equal<typeof servicesEffect, Async<LayerContext, MissingLayerServiceError, { readonly config: { readonly port: number } }>>>;

type _servicesOf = Expect<Equal<ServicesOf<{ readonly config: typeof Config }>, { readonly config: { readonly port: number } }>>;

const provided = provideContext(
  ConfigLayer,
  (ctx) => asyncSucceed(ctx.unsafeGet(Config).port),
);
const providedValue: Async<unknown, never, number> = provided;
void providedValue;

const providedAlias = provide(
  ConfigLayer,
  (ctx) => asyncSucceed(ctx.unsafeGet(Config).port),
  undefined,
);
const providedAliasValue: Async<unknown, never, number> = providedAlias;
void providedAliasValue;

const providedWithUseAll = provideContext(
  ConfigLayer,
  useServices({ config: Config }, ({ config }) => asyncSucceed(config.port)),
);
const providedWithUseAllValue: Async<unknown, MissingLayerServiceError, number> = providedWithUseAll;
void providedWithUseAllValue;

const mergedLayer = Layer.all(ConfigLayer);
void mergedLayer;

const composedLayer = composeAll(ConfigLayer);
void composedLayer;

const runtime = makeRuntime({ prefix: "brass" });
const promise = runPromise(asyncSucceed(1), runtime);
type _runPromise = Expect<Equal<typeof promise, Promise<number>>>;

const exit = runExit(asyncSucceed("ok"));
type _runExit = Expect<Equal<typeof exit, Promise<Exit<never, string>>>>;
