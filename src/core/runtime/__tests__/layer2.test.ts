import { describe, expect, it } from "vitest";

import { asyncFail, asyncFlatMap, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import {
  buildLayer,
  compose,
  composeAll,
  layer,
  Layer,
  LayerContext,
  layerEffect,
  layerFail,
  layerFrom,
  layerValue,
  makeLayerScope,
  makeServiceTag,
  mapLayer,
  merge,
  mergeAll,
  provideLayer,
  provideLayerContext,
  useService,
  useServices,
} from "../layer";
import { Runtime } from "../runtime";
import { neverEffect } from "../testing";

const run = <A>(effect: any): Promise<A> => Runtime.make({}).toPromise(effect) as Promise<A>;

describe("Layer 2.0", () => {
  it("builds typed service contexts and provides them to effects", async () => {
    type Config = { readonly url: string };
    type Db = { readonly query: () => string };
    const ConfigTag = makeServiceTag<Config>("Config");
    const DbTag = makeServiceTag<Db>("Db");
    const releases: string[] = [];

    const ConfigLayer = layerValue(ConfigTag, { url: "postgres://local" });
    const DbLayer = layerEffect(
      DbTag,
      (ctx) => {
        const config = ctx.unsafeGet(ConfigTag);
        return asyncSucceed({ query: () => `select:${config.url}` });
      },
      () => asyncSync(() => { releases.push("db"); }) as any,
    );

    const AppLayer = compose(ConfigLayer, DbLayer);

    await expect(run(provideLayerContext(
      AppLayer,
      (ctx) => asyncSucceed({
        db: ctx.unsafeGet(DbTag).query(),
        hasConfig: ctx.has(ConfigTag),
        missing: ctx.get(makeServiceTag<{ nope: true }>("Missing")),
        size: ctx.size(),
      }),
    ))).resolves.toEqual({
      db: "select:postgres://local",
      hasConfig: true,
      missing: undefined,
      size: 2,
    });
    expect(releases).toEqual(["db"]);
  });

  it("merges contexts and keeps right-hand service overrides", async () => {
    const Service = makeServiceTag<{ readonly value: string }>("Service");
    const Other = makeServiceTag<{ readonly n: number }>("Other");
    const left = LayerContext.empty().add(Service, { value: "left" });
    const right = new LayerContext([[Service, { value: "right" }], [Other, { n: 1 }]]);

    const mergedContext = left.merge(right);
    expect(mergedContext.unsafeGet(Service).value).toBe("right");
    expect(mergedContext.unsafeGet(Other).n).toBe(1);
    expect(() => mergedContext.unsafeGet(makeServiceTag("Missing"))).toThrow(/Missing layer service 'Missing'/);

    const mergedLayer = merge(layerValue(Service, { value: "a" }), layerValue(Other, { n: 2 }));
    await expect(run(provideLayerContext(mergedLayer, (ctx) =>
      asyncSucceed([ctx.unsafeGet(Service).value, ctx.unsafeGet(Other).n] as const)
    ))).resolves.toEqual(["a", 2]);
  });

  it("memoizes shared dependencies inside a scoped layer build", async () => {
    const events: string[] = [];
    const base = layer(
      () => asyncSync(() => {
        events.push("acquire");
        return { value: 7 };
      }) as any,
      () => asyncSync(() => { events.push("release"); }) as any,
    );
    const left = mapLayer(base, (svc) => ({ left: svc.value }));
    const right = mapLayer(base, (svc) => ({ right: svc.value }));
    const app = merge(left, right);

    await expect(run(provideLayer(app, (svc) => asyncSucceed(svc)))).resolves.toEqual({ left: 7, right: 7 });
    expect(events).toEqual(["acquire", "release"]);
  });

  it("builds layers for manual lifecycle and closes idempotently", async () => {
    const events: string[] = [];
    const l = layer(
      () => asyncSucceed({ ready: true }),
      () => asyncSync(() => { events.push("release"); }) as any,
    );

    const built = await run(buildLayer(l));
    expect(built.service.ready).toBe(true);
    await expect(run(built.use((service) => asyncSucceed(service.ready)))).resolves.toBe(true);
    await expect(run(built.close())).resolves.toBeUndefined();
    await expect(run(built.close())).resolves.toBeUndefined();
    expect(built.scope.size()).toBe(0);
    expect(events).toEqual(["release"]);
  });

  it("releases acquired dependencies when later layer construction fails", async () => {
    const events: string[] = [];
    const acquired = layer(
      () => asyncSync(() => {
        events.push("acquire");
        return { db: true };
      }) as any,
      () => asyncSync(() => { events.push("release"); }) as any,
    );
    const failing = layerFail("build-failed");

    await expect(run(provideLayer(compose(acquired, failing as any), () => asyncSucceed("never")))).rejects.toBe("build-failed");
    expect(events).toEqual(["acquire", "release"]);
  });

  it("can use an explicit LayerScope and rejects use after close", async () => {
    const scope = makeLayerScope();
    const l = layer(() => asyncSucceed({ service: "x" }));

    await expect(run(scope.get(l))).resolves.toEqual({ service: "x" });
    await expect(run(scope.get(l))).resolves.toEqual({ service: "x" });
    expect(scope.size()).toBe(1);
    await expect(run(scope.close())).resolves.toBeUndefined();
    await expect(run(scope.get(l))).rejects.toThrow(/LayerScope is closed/);
  });

  it("exposes the Layer namespace helpers", async () => {
    const Tag = Layer.tag<{ readonly value: string }>("Tagged");
    const l = Layer.effect(Tag, () => asyncSucceed({ value: "ok" }));

    await expect(run(Layer.provideContext(
      l,
      (ctx) => asyncSucceed(ctx.unsafeGet(Tag).value),
    ))).resolves.toBe("ok");

    await expect(run(Layer.provide(
      Layer.succeed({ a: 1 }),
      (svc) => asyncSucceed(svc.a),
    ))).resolves.toBe(1);
  });

  it("merges many layers and consumes typed services without unsafe context reads", async () => {
    const Config = Layer.tag<{ readonly baseUrl: string }>("Config");
    const Http = Layer.tag<{ readonly get: (path: string) => string }>("Http");
    const Repo = Layer.tag<{ readonly findUser: (id: string) => string }>("Repo");

    const ConfigLayer = Layer.value(Config, { baseUrl: "https://api.example.com" });
    const HttpLayer = Layer.effect(Http, (ctx) => {
      const config = ctx.unsafeGet(Config);
      return asyncSucceed({ get: (path: string) => `${config.baseUrl}${path}` });
    });
    const RepoLayer = Layer.effect(Repo, (ctx) => {
      const http = ctx.unsafeGet(Http);
      return asyncSucceed({ findUser: (id: string) => http.get(`/users/${id}`) });
    });

    const AppLayer = composeAll(ConfigLayer, HttpLayer, RepoLayer);

    await expect(run(provideLayerContext(
      AppLayer,
      useServices({ config: Config, repo: Repo }, ({ config, repo }) =>
        asyncSucceed({
          baseUrl: config.baseUrl,
          userUrl: repo.findUser("42"),
        })
      ),
    ))).resolves.toEqual({
      baseUrl: "https://api.example.com",
      userUrl: "https://api.example.com/users/42",
    });

    await expect(run(provideLayerContext(
      AppLayer,
      Layer.useAll({ http: Http }, ({ http }) => asyncSucceed(http.get("/health"))),
    ))).resolves.toBe("https://api.example.com/health");

    await expect(run(provideLayerContext(
      Layer.all(Layer.value(Config, { baseUrl: "left" }), Layer.value(Http, { get: (path) => `right${path}` })),
      Layer.useAll({ config: Config, http: Http }, ({ config, http }) =>
        asyncSucceed(`${config.baseUrl}:${http.get("/ok")}`)
      ),
    ))).resolves.toBe("left:right/ok");
  });

  it("surfaces missing services through useService", async () => {
    const Existing = Layer.tag<{ readonly ok: true }>("Existing");
    const Missing = Layer.tag<{ readonly value: string }>("Missing");

    await expect(run(provideLayerContext(
      Layer.value(Existing, { ok: true }),
      useService(Missing, (service) => asyncSucceed(service.value)),
    ))).rejects.toMatchObject({
      _tag: "MissingLayerService",
      serviceName: "Missing",
    });
  });

  it("runs layer finalizers when provided use is interrupted", async () => {
    const events: string[] = [];
    const rt = Runtime.make({});
    const l = layer(
      () => asyncSucceed({ alive: true }),
      () => asyncSync(() => { events.push("release"); }) as any,
    );
    const fiber = rt.fork(provideLayer(l, () => neverEffect()));

    await new Promise((resolve) => setImmediate(resolve));
    fiber.interrupt();
    await expect(new Promise((resolve) => fiber.join(resolve))).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Interrupt" },
    });
    expect(events).toEqual(["release"]);
  });

  it("closes partially built manual layers when buildLayer fails", async () => {
    const events: string[] = [];
    const acquired = layer(
      () => asyncSucceed({ n: 1 }),
      () => asyncSync(() => { events.push("release"); }) as any,
    );

    await expect(run(buildLayer(compose(acquired, layerFail("nope") as any)))).rejects.toBe("nope");
    expect(events).toEqual(["release"]);
  });

  it("preserves use failures after releasing provided layers", async () => {
    const events: string[] = [];
    const l = layer(
      () => asyncSucceed({ ok: true }),
      () => asyncSync(() => { events.push("release"); }) as any,
    );

    await expect(run(provideLayer(l, () => asyncFail("use-failed")))).rejects.toBe("use-failed");
    expect(events).toEqual(["release"]);
  });

  it("keeps legacy merge behavior for plain object services", async () => {
    const app = merge(Layer.succeed({ a: 1 }), Layer.succeed({ b: 2 }));
    await expect(run(provideLayer(app, (svc) => asyncSucceed(svc)))).resolves.toEqual({ a: 1, b: 2 });
  });

  it("keeps legacy compose build success and release ordering", async () => {
    const events: string[] = [];
    const config = layer(
      () => asyncSucceed({ n: 2 }),
      () => asyncSync(() => { events.push("release-config"); }) as any,
    );
    const service = layerFrom<{ readonly n: number }>()(
      (deps) => asyncSucceed({ value: deps.n + 1 }),
      () => asyncSync(() => { events.push("release-service"); }) as any,
    );

    const built = await run(compose(config, service).build(undefined));
    expect(built.service.value).toBe(3);
    await expect(run(built.release())).resolves.toBeUndefined();
    expect(events).toEqual(["release-service", "release-config"]);
  });

  it("keeps legacy compose build failure release behavior", async () => {
    const events: string[] = [];
    const acquired = layer(
      () => asyncSucceed({ n: 1 }),
      () => asyncSync(() => { events.push("release-acquired"); }) as any,
    );

    await expect(run(compose(acquired, layerFail("compose-failed") as any).build(undefined))).rejects.toBe("compose-failed");
    expect(events).toEqual(["release-acquired"]);
  });

  it("keeps legacy merge build success and release ordering", async () => {
    const events: string[] = [];
    const left = layer(
      () => asyncSucceed({ left: 1 }),
      () => asyncSync(() => { events.push("release-left"); }) as any,
    );
    const right = layer(
      () => asyncSucceed({ right: 2 }),
      () => asyncSync(() => { events.push("release-right"); }) as any,
    );

    const built = await run(merge(left, right).build(undefined as any));
    expect(built.service).toEqual({ left: 1, right: 2 });
    await expect(run(built.release())).resolves.toBeUndefined();
    expect(events).toEqual(["release-right", "release-left"]);
  });

  it("keeps legacy merge build failure release behavior", async () => {
    const events: string[] = [];
    const left = layer(
      () => asyncSucceed({ left: 1 }),
      () => asyncSync(() => { events.push("release-left"); }) as any,
    );

    await expect(run(merge(left, layerFail("merge-failed") as any).build(undefined as any))).rejects.toBe("merge-failed");
    expect(events).toEqual(["release-left"]);
  });

  it("keeps legacy map build behavior", async () => {
    const built = await run(mapLayer(Layer.succeed(2), (n) => n * 3).build(undefined));
    expect(built.service).toBe(6);
    await expect(run(built.release())).resolves.toBeUndefined();
  });

  it("supports layerFrom without a release finalizer", async () => {
    const l = layerFrom<{ readonly base: number }>()((deps) => asyncSucceed(deps.base + 4));

    const built = await run(l.build({ base: 3 }));
    expect(built.service).toBe(7);
    await expect(run(built.release())).resolves.toBeUndefined();
  });

  it("continues closing remaining scoped finalizers when one finalizer fails", async () => {
    const events: string[] = [];
    const failing = layer(
      () => asyncSucceed({ failing: true }),
      () => asyncFail("release-failed") as any,
    );
    const succeeding = layer(
      () => asyncSucceed({ succeeding: true }),
      () => asyncSync(() => { events.push("release-succeeding"); }) as any,
    );

    await expect(run(provideLayer(merge(failing, succeeding), (svc) => asyncSucceed(svc)))).resolves.toEqual({
      failing: true,
      succeeding: true,
    });
    expect(events).toEqual(["release-succeeding"]);
  });

  it("falls back to Object.assign for legacy non-object merge outputs", async () => {
    const app = merge(Layer.succeed(1 as any), Layer.succeed("x" as any));

    await expect(run(provideLayer(app, (svc) => asyncSucceed(svc)))).resolves.toEqual({ 0: "x" });
  });
});
