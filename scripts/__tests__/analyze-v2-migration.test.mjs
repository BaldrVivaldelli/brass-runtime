import { describe, expect, it } from "vitest";
import { analyzeSource } from "../analyze-v2-migration.mjs";

describe("v2 migration analyzer", () => {
  it("maps only documented v1 operations and preserves local aliases", () => {
    const report = analyzeSource("app.ts", `
      import { succeed as ok, flatMap, layerValue, toPromise } from "brass-runtime";
      import type { Resource, Fiber } from "brass-runtime/core";
    `);

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ imported: "succeed", local: "ok", replacement: "Effect.succeed", classification: "mapped" }),
      expect.objectContaining({ imported: "flatMap", replacement: "Effect.flatMap", classification: "mapped" }),
      expect.objectContaining({ imported: "layerValue", replacement: "Layer.value", classification: "mapped" }),
      expect.objectContaining({ imported: "toPromise", replacement: "runPromise", classification: "mapped" }),
      expect.objectContaining({ imported: "Resource", replacement: "ResourceDescriptor", typeOnly: true }),
      expect.objectContaining({ imported: "Fiber", replacement: "Fiber", typeOnly: true }),
    ]));
  });

  it("requires manual review for unknown, namespace, and default imports", () => {
    const report = analyzeSource("manual.ts", `
      import Brass, * as RuntimeApi from "brass-runtime";
      import { globalScheduler } from "brass-runtime/core";
    `);

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ imported: "default", classification: "manual" }),
      expect.objectContaining({ imported: "*", classification: "manual" }),
      expect.objectContaining({ imported: "globalScheduler", classification: "manual" }),
    ]));
  });

  it("ignores domain subpaths that are not replaced by the v2 root", () => {
    const report = analyzeSource("http.ts", `
      import { makeDefaultHttpClient } from "brass-runtime/http";
      import { s } from "brass-runtime/schema";
      import { Effect } from "brass-runtime/next";
    `);

    expect(report.findings).toEqual([]);
  });

  it("detects named, aliased, type-only, namespace, and star re-exports", () => {
    const report = analyzeSource("facade.ts", `
      export { zipPar, toPromise as run } from "brass-runtime";
      export type { Fiber } from "brass-runtime/core";
      export * as Legacy from "brass-runtime";
      export * from "brass-runtime/core";
    `);

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ imported: "zipPar", local: "zipPar", classification: "manual" }),
      expect.objectContaining({ imported: "toPromise", local: "run", replacement: "runPromise", classification: "mapped" }),
      expect.objectContaining({ imported: "Fiber", typeOnly: true, replacement: "Fiber", classification: "mapped" }),
      expect.objectContaining({ imported: "*", local: "Legacy", classification: "manual" }),
      expect.objectContaining({ imported: "*", local: null, classification: "manual" }),
    ]));
  });
});
