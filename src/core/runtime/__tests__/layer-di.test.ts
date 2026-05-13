import { describe, expect, it } from "vitest";

import { Schema, ConfigValidationError } from "../../../schema";
import { asyncSucceed } from "../../types/asyncEffect";
import {
  Layer,
  makeConfigLayer,
  makeRuntimeLayer,
  makeTestLayer,
  makeTestLayers,
  RuntimeService,
} from "../../../index";
import { Runtime } from "../runtime";

describe("Layer DI helpers", () => {
  it("validates config and wires a Runtime service from context", async () => {
    const AppConfig = Layer.tag<{ readonly port: number; readonly serviceName: string }>("AppConfig");
    const ConfigSchema = Schema.object({
      port: Schema.int({ min: 1 }),
      serviceName: Schema.nonEmptyString(),
    });

    const AppLayer = Layer.composeAll(
      makeConfigLayer(AppConfig, ConfigSchema, {
        port: 3000,
        serviceName: "orders-api",
      }),
      makeRuntimeLayer((ctx) => ({
        config: ctx.unsafeGet(AppConfig),
      }), { inferLane: false }),
    );

    const result = await Runtime.make({}).toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.useAll({ config: AppConfig, runtime: RuntimeService }, ({ config, runtime }) =>
          asyncSucceed({
            port: config.port,
            runtimeEnv: runtime.env,
            activeHooks: runtime.hasActiveHooks(),
          }),
        ),
      ),
    );

    expect(result).toEqual({
      port: 3000,
      runtimeEnv: {
        config: {
          port: 3000,
          serviceName: "orders-api",
        },
      },
      activeHooks: false,
    });
  });

  it("supports function config sources and static Runtime envs", async () => {
    const AppConfig = Layer.tag<{ readonly serviceName: string }>("FunctionConfig");
    const ConfigSchema = Schema.object({
      serviceName: Schema.nonEmptyString(),
    });

    const AppLayer = Layer.composeAll(
      makeConfigLayer(AppConfig, ConfigSchema, () => ({
        serviceName: "inventory-api",
      })),
      makeRuntimeLayer({ mode: "static" }, { inferLane: false }),
    );

    const result = await Runtime.make({}).toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.useAll({ config: AppConfig, runtime: RuntimeService }, ({ config, runtime }) =>
          asyncSucceed({
            serviceName: config.serviceName,
            runtimeEnv: runtime.env,
          }),
        ),
      ),
    );

    expect(result).toEqual({
      serviceName: "inventory-api",
      runtimeEnv: { mode: "static" },
    });
  });

  it("fails config layers with ConfigValidationError", async () => {
    const AppConfig = Layer.tag<{ readonly port: number }>("AppConfig");
    const ConfigSchema = Schema.object({
      port: Schema.int({ min: 1 }),
    });

    await expect(Runtime.make({}).toPromise(
      Layer.provideContext(
        makeConfigLayer(AppConfig, ConfigSchema, { port: 0 }, { name: "AppConfig" }),
        Layer.use(AppConfig, (config) => asyncSucceed(config.port)),
      ),
    )).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it("creates simple test layers for service replacement", async () => {
    const Config = Layer.tag<{ readonly baseUrl: string }>("Config");
    const Repo = Layer.tag<{ readonly find: (id: string) => string }>("Repo");

    const TestLayer = makeTestLayers(
      [Config, { baseUrl: "test://users" }],
      [Repo, { find: (id: string) => `mock:${id}` }],
    );

    await expect(Runtime.make({}).toPromise(
      Layer.provideContext(
        Layer.composeAll(makeTestLayer(Config, { baseUrl: "ignored" }), TestLayer),
        Layer.useAll({ config: Config, repo: Repo }, ({ config, repo }) =>
          asyncSucceed(`${config.baseUrl}:${repo.find("42")}`),
        ),
      ),
    )).resolves.toBe("test://users:mock:42");
  });
});
