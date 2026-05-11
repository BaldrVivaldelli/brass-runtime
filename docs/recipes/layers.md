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
  provideContext(AppLayer, (ctx) =>
    asyncSucceed(ctx.unsafeGet(Repo).findUser("u1")),
  ),
);

console.log(userUrl);
```

Missing services throw `MissingLayerServiceError`; use `formatLayerError` when
surfacing the message.
