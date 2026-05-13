import { describe, expect, it } from "vitest";

import * as root from "../index";
import * as core from "../core";
import * as http from "../http";
import * as observability from "../observability";
import * as perf from "../perf";
import * as schema from "../schema";

const REQUIRED_EXPORTS = Object.freeze({
  root: [
    "Runtime",
    "runPromise",
    "runExit",
    "makeRuntime",
    "asyncSucceed",
    "asyncFlatMap",
    "Cause",
    "Exit",
    "Layer",
    "LayerContext",
    "defineService",
    "getService",
    "getServices",
    "useServices",
    "composeAll",
    "makeConfigLayer",
    "makeRuntimeLayer",
    "RuntimeService",
    "makeTestLayer",
    "provide",
    "provideLayer",
    "Schedule",
    "makeScheduleDriver",
    "makeFiberRef",
    "Stream",
    "Pipeline",
  ],
  core: [
    "Runtime",
    "runPromise",
    "runExit",
    "makeRuntime",
    "Layer",
    "defineService",
    "getService",
    "getServices",
    "useServices",
    "composeAll",
    "makeConfigLayer",
    "makeRuntimeLayer",
    "RuntimeService",
    "makeTestLayer",
    "formatLayerError",
    "Schedule",
    "makeTestRuntime",
  ],
  http: [
    "makeDefaultHttpClient",
    "makeDefaultHttpClientLayer",
    "HttpClientService",
    "httpClientBuilder",
    "makeHttpRouter",
    "route",
    "HttpServer",
    "makeNodeHttpServer",
    "formatHttpError",
    "s",
  ],
  observability: [
    "makeObservability",
    "makeObservabilityLayer",
    "makeObservedHttpClientLayer",
    "ObservabilityService",
    "withHttpObservability",
  ],
  schema: [
    "Schema",
    "s",
    "formatIssues",
    "formatConfigError",
    "isConfigValidationError",
    "parseConfig",
  ],
  perf: [
    "runBrassPerformanceProfile",
    "profileRuntimeAb",
    "profileRuntimeSoak",
    "profileHttpMemoryLab",
    "createPerfHistoryEntry",
    "recordPerfHistoryRun",
    "savePerfBaseline",
    "comparePerfToBaseline",
  ],
});

describe("public API release snapshot", () => {
  it("keeps first-release DX exports discoverable", () => {
    expectMissing("root", root, REQUIRED_EXPORTS.root);
    expectMissing("core", core, REQUIRED_EXPORTS.core);
    expectMissing("http", http, REQUIRED_EXPORTS.http);
    expectMissing("observability", observability, REQUIRED_EXPORTS.observability);
    expectMissing("schema", schema, REQUIRED_EXPORTS.schema);
    expectMissing("perf", perf, REQUIRED_EXPORTS.perf);
  });

  it("does not leak obvious generated or test-only symbols from public barrels", () => {
    for (const [name, module] of Object.entries({ root, core, http, observability, schema, perf })) {
      const leaked = Object.keys(module).filter((key) =>
        key.includes("__")
        || key.endsWith("TypeTest")
        || key.endsWith("typeTests")
        || key === "default"
      );
      expect(leaked, `${name} leaked ${leaked.join(", ")}`).toEqual([]);
    }
  });
});

function expectMissing(name: string, module: Record<string, unknown>, required: readonly string[]): void {
  const missing = required.filter((key) => !(key in module));
  expect(missing, `${name} missing ${missing.join(", ")}`).toEqual([]);
}
