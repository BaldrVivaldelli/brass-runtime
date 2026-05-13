# Layers Recipe

Use `defineService` for typed service tags, `Layer.effect` or `Layer.value` to
provide them, and `provideContext` to run a program with a scoped dependency
graph.

```ts
import {
  Layer,
  LayerContext,
  asyncSucceed,
  defineService,
  provideContext,
  runPromise,
} from "brass-runtime";

type Config = { readonly baseUrl: string };
type Repo = { readonly findUser: (id: string) => string };

const Config = defineService<Config>("Config");
const Repo = defineService<Repo>("Repo");

const ConfigLayer = Layer.value(Config, { baseUrl: "https://api.example.com" });

const RepoLayer = Layer.effect(Repo, (ctx: LayerContext) => {
  const config = ctx.unsafeGet(Config);
  return asyncSucceed({
    findUser: (id) => `${config.baseUrl}/users/${id}`,
  });
});

const AppLayer = Layer.compose(ConfigLayer, RepoLayer);

const userUrl = await runPromise(
  provideContext(
    AppLayer,
    Layer.use(Repo, (repo) => asyncSucceed(repo.findUser("u1"))),
  ),
);

console.log(userUrl);
```

Missing services throw `MissingLayerServiceError`; use `formatLayerError` when
surfacing the message.

For independent layers, `Layer.all(...)` keeps composition readable. For
ordered context graphs where later layers read earlier services, use
`Layer.composeAll(...)`. `Layer.useAll(...)` reads multiple services without
manual context access:

```ts
const Logger = defineService<{ readonly info: (message: string) => void }>("Logger");
const LoggerLayer = Layer.value(Logger, console);

const AppLayer2 = Layer.composeAll(ConfigLayer, RepoLayer, LoggerLayer);

await runPromise(
  provideContext(
    AppLayer2,
    Layer.useAll({ repo: Repo, logger: Logger }, ({ repo, logger }) => {
      logger.info("loading user");
      return asyncSucceed(repo.findUser("u1"));
    }),
  ),
);
```

For app wiring, prefer the focused helpers:

```ts
import { RuntimeService, makeConfigLayer, makeRuntimeLayer, makeTestLayer } from "brass-runtime";
import { s } from "brass-runtime/schema";

const ConfigSchema = s.object({ baseUrl: s.url() });

const ConfigLayer2 = makeConfigLayer(Config, ConfigSchema, {
  baseUrl: "https://api.example.com",
});

const RuntimeLayer = makeRuntimeLayer((ctx) => ({
  config: ctx.unsafeGet(Config),
}));

const TestConfigLayer = makeTestLayer(Config, {
  baseUrl: "https://test.example.com",
});
```
