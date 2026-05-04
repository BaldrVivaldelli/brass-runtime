import { createRequire } from "node:module";

export type WasmRuntimeModule = Record<string, unknown>;

type RuntimeRequire = ((id: string) => unknown) & { resolve?: (id: string) => string };

let cachedWasmModule: WasmRuntimeModule | null | undefined;
let cachedWasmModuleErrors: string[] = [];

export type ResolveWasmModuleOptions = {
  modulePath?: string;
  fresh?: boolean;
};

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
    "brass-runtime/wasm/pkg/brass_runtime_wasm_engine.js",
    "../wasm/pkg/brass_runtime_wasm_engine.js",
    "../../../wasm/pkg/brass_runtime_wasm_engine.js",
    "../../../../../wasm/pkg/brass_runtime_wasm_engine.js",
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
    return (0, eval)(
      "typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : undefined",
    ) as RuntimeRequire | undefined;
  } catch {
    return undefined;
  }
}

function getRuntimeRequire(): RuntimeRequire | undefined {
  try {
    return (0, eval)(
      "typeof require === 'function' ? require : undefined",
    ) as RuntimeRequire | undefined;
  } catch {
    return undefined;
  }
}

function getCreateRequire(): RuntimeRequire | undefined {
  try {
    return createRequire(`${getCwd()}/package.json`) as RuntimeRequire;
  } catch {
    return undefined;
  }
}

function getCwd(): string {
  try {
    return (0, eval)(
      "typeof process !== 'undefined' ? process.cwd() : ''",
    ) as string;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}