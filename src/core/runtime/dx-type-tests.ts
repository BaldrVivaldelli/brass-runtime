import {
  asyncSucceed,
  type Async,
} from "../types/asyncEffect";
import type { Exit } from "../types/effect";
import {
  defineService,
  getService,
  layerValue,
  provide,
  provideContext,
  type LayerContext,
  type MissingLayerServiceError,
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

const runtime = makeRuntime({ prefix: "brass" });
const promise = runPromise(asyncSucceed(1), runtime);
type _runPromise = Expect<Equal<typeof promise, Promise<number>>>;

const exit = runExit(asyncSucceed("ok"));
type _runExit = Expect<Equal<typeof exit, Promise<Exit<never, string>>>>;
