import { createRequire } from "node:module";

export type WasmRuntimeModule = Record<string, unknown>;

type RuntimeRequire = ((id: string) => unknown) & { resolve?: (id: string) => string };

let cachedWasmModule: WasmRuntimeModule | null | undefined;
let cachedWasmModuleErrors: string[] = [];

export type ResolveWasmModuleOptions = {
  /** Explicit module path for tests or custom package layouts. */
  modulePath?: string;
  /** Disable the cache, mostly useful in tests. */
  fresh?: boolean;
};

/**
 * Resolves the wasm-pack generated CommonJS module in Node-friendly runtimes.
 *
 * This intentionally avoids a static import of wasm/pkg because many consumers
 * bundle brass-runtime with webpack. Static imports make webpack try to inline
 * the wasm-pack artifact; that is usually the wrong behavior for Node services,
 * because wasm-pack's nodejs target expects the .wasm file to live next to the
 * generated JS file on disk.
 *
 * Supported cases:
 * - Node 18 CommonJS consumers.
 * - Node 18 ESM consumers via createRequire(import.meta.url).
 * - webpack for Node via __non_webpack_require__ when available.
 * - Local source/test execution before packaging.
 */
export function resolveWasmModule(options: ResolveWasmModuleOptions = {}): WasmRuntimeModule | null {
  if (!options.fresh && options.modulePath == null && cachedWasmModule !== undefined) {
    return cachedWasmModule;
  }

  const req = getBestRequire();
  const candidates = wasmModuleCandidates(options.modulePath);
  const errors: string[] = [];

  if (!req) {
    errors.push("no CommonJS-compatible require/createRequire was available");
    return remember(options, null, errors);
  }

  for (const candidate of candidates) {
    try {
      return remember(options, req(candidate) as WasmRuntimeModule, errors);
    } catch (error) {
      errors.push(`${candidate}: ${formatError(error)}`);
    }
  }

  return remember(options, null, errors);
}

export function wasmModuleResolutionErrors(): string[] {
  return cachedWasmModuleErrors.slice();
}

export function resetWasmModuleCache(): void {
  cachedWasmModule = undefined;
  cachedWasmModuleErrors = [];
}

export function wasmModuleCandidates(modulePath?: string): string[] {
  if (modulePath) return [modulePath];

  return [
    // Installed package path. Useful when brass-runtime is bundled by webpack
    // but the package still exists in node_modules at runtime.
    "brass-runtime/wasm/pkg/brass_runtime_wasm_engine.js",
    // Bundled package path: dist/index.(js|cjs) -> ../wasm/pkg/...
    "../wasm/pkg/brass_runtime_wasm_engine.js",
    // Source/test paths used by tsx/vitest before publishing.
    "../../../wasm/pkg/brass_runtime_wasm_engine.js",
    "../../../../../wasm/pkg/brass_runtime_wasm_engine.js",
    // Local workspace fallback.
    `${getCwd()}/wasm/pkg/brass_runtime_wasm_engine.js`,
  ];
}

function remember(
  options: ResolveWasmModuleOptions,
  value: WasmRuntimeModule | null,
  errors: string[],
): WasmRuntimeModule | null {
  if (!options.fresh && options.modulePath == null) {
    cachedWasmModule = value;
    cachedWasmModuleErrors = errors;
  }
  return value;
}

function getBestRequire(): RuntimeRequire | undefined {
  return getNonWebpackRequire() ?? getRuntimeRequire() ?? getCreateRequire();
}

function getNonWebpackRequire(): RuntimeRequire | undefined {
  try {
    return (0, eval)("typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : undefined") as RuntimeRequire | undefined;
  } catch {
    return undefined;
  }
}

function getRuntimeRequire(): RuntimeRequire | undefined {
  try {
    return (0, eval)("typeof require === 'function' ? require : undefined") as RuntimeRequire | undefined;
  } catch {
    return undefined;
  }
}

function getCreateRequire(): RuntimeRequire | undefined {
  try {
    return createRequire(import.meta.url) as RuntimeRequire;
  } catch {
    return undefined;
  }
}

function getCwd(): string {
  try {
    return (0, eval)("typeof process !== 'undefined' ? process.cwd() : ''") as string;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
