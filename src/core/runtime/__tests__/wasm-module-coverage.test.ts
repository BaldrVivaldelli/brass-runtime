import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetWasmModuleCache,
  resolveWasmModule,
  wasmModuleCandidates,
  wasmModuleResolutionErrors,
} from "../wasmModule";

describe("wasm module resolution helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("node:module");
    vi.resetModules();
    resetWasmModuleCache();
  });

  it("returns an explicit module path as the only candidate", () => {
    expect(wasmModuleCandidates("custom/pkg.js")).toEqual(["custom/pkg.js"]);
  });

  it("builds default candidates including package, relative, and cwd paths", () => {
    const candidates = wasmModuleCandidates();

    expect(candidates[0]).toBe("brass-runtime/wasm/pkg/brass_runtime_wasm_engine.js");
    expect(candidates).toContain("../wasm/pkg/brass_runtime_wasm_engine.js");
    expect(candidates.at(-1)).toMatch(/\/wasm\/pkg\/brass_runtime_wasm_engine\.js$/);
  });

  it("resolves explicit CommonJS-compatible modules without updating the default cache", () => {
    const fsModule = resolveWasmModule({ modulePath: "node:fs", fresh: true });

    expect(fsModule).toMatchObject({ readFile: expect.any(Function) });
    expect(wasmModuleResolutionErrors()).toEqual([]);
  });

  it("reports explicit resolution failures and keeps cached errors immutable", () => {
    const missing = resolveWasmModule({
      modulePath: "./missing-brass-runtime-wasm-module-for-test.js",
      fresh: true,
    });

    expect(missing).toBeNull();
    expect(wasmModuleResolutionErrors()).toEqual([]);

    const first = resolveWasmModule();
    const cachedErrors = wasmModuleResolutionErrors();
    cachedErrors.push("mutated outside");

    expect(resolveWasmModule()).toBe(first);
    expect(wasmModuleResolutionErrors()).not.toContain("mutated outside");
  });

  it("reports no compatible require when eval and createRequire are unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("eval", () => {
      throw new Error("eval disabled");
    });
    vi.doMock("node:module", () => ({
      createRequire: () => {
        throw new Error("createRequire disabled");
      },
    }));

    const fresh = await import("../wasmModule");
    expect(fresh.resolveWasmModule()).toBeNull();
    expect(fresh.wasmModuleResolutionErrors()).toEqual([
      "no CommonJS-compatible require/createRequire was available",
    ]);
  });
});
