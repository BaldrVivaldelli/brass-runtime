import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import * as root from "../index";
import * as core from "../core";
import * as next from "../next";
import * as http from "../http";
import * as httpTesting from "../http/testing";
import * as observability from "../observability";
import * as perf from "../perf";
import * as schema from "../schema";

const EXACT_EXPORT_SNAPSHOTS = Object.freeze({
  root: { count: 331, sha256: "4c29e3941ec902b0a728e47deb8c6a45b00d5c9b55353567eb25c4554ac5eaa9" },
  core: { count: 331, sha256: "4c29e3941ec902b0a728e47deb8c6a45b00d5c9b55353567eb25c4554ac5eaa9" },
  next: { count: 20, sha256: "3c7a6cfb5b980d7bf0eb6bd78917a41d02ec1d5add9fb64e8978d8bbc62cbda9" },
  http: { count: 156, sha256: "6413697e1da8b34120c8d6b6112ee39159870bdbad0fe1f86c27837bce43c253" },
  httpTesting: { count: 12, sha256: "096ea6dca6b1e10f96e9e3cda9f0188f54dd19040d1e7c6ee2bec4acc95f7851" },
  schema: { count: 12, sha256: "bfd3feaf9db8a8367da8ab9ced8d6a5adba4110b167ef7487ef89ffd8168b0bb" },
  observability: { count: 80, sha256: "6c5b34368837e36f244ec40d3dd0a0f8eae20fd073a71ca08987ed1240391343" },
  perf: { count: 33, sha256: "8db943c81dfc3f997007458289fb956779c707c85dce5192f64139fc4bc9c77d" },
});

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
  next: [
    "Effect",
    "Cause",
    "Exit",
    "Runtime",
    "makeRuntime",
    "runPromise",
    "runExit",
    "Scope",
    "Resource",
    "Layer",
    "Schedule",
    "Stream",
    "Pipeline",
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
  it("freezes the complete runtime export surface for every package entrypoint", () => {
    const modules = { root, core, next, http, httpTesting, schema, observability, perf };
    const actual = Object.fromEntries(
      Object.entries(modules).map(([name, module]) => [name, exportFingerprint(module)]),
    );

    expect(actual).toEqual(EXACT_EXPORT_SNAPSHOTS);
  });

  it("keeps first-release DX exports discoverable", () => {
    expectMissing("root", root, REQUIRED_EXPORTS.root);
    expectMissing("core", core, REQUIRED_EXPORTS.core);
    expectMissing("next", next, REQUIRED_EXPORTS.next);
    expectMissing("http", http, REQUIRED_EXPORTS.http);
    expectMissing("observability", observability, REQUIRED_EXPORTS.observability);
    expectMissing("schema", schema, REQUIRED_EXPORTS.schema);
    expectMissing("perf", perf, REQUIRED_EXPORTS.perf);
  });

  it("does not leak obvious generated or test-only symbols from public barrels", () => {
    for (const [name, module] of Object.entries({ root, core, next, http, observability, schema, perf })) {
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

function exportFingerprint(module: Record<string, unknown>): { count: number; sha256: string } {
  const keys = Object.keys(module).sort();
  return {
    count: keys.length,
    sha256: createHash("sha256").update(keys.join("\n")).digest("hex"),
  };
}

function expectMissing(name: string, module: Record<string, unknown>, required: readonly string[]): void {
  const missing = required.filter((key) => !(key in module));
  expect(missing, `${name} missing ${missing.join(", ")}`).toEqual([]);
}
