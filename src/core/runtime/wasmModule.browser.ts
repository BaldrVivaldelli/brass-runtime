export type WasmRuntimeModule = Record<string, unknown>;

export type ResolveWasmModuleOptions = {
  readonly modulePath?: string;
  readonly fresh?: boolean;
};

export const STRICT_WASM_VM_EXPORTS = [] as const;

export type StrictWasmModuleStatus = {
  readonly compatible: boolean;
  readonly missing: readonly string[];
  readonly error?: string;
};

export function inspectStrictWasmModule(
  _module: WasmRuntimeModule | null,
): StrictWasmModuleStatus {
  return { compatible: false, missing: ["BrassWasmVm"], error: BROWSER_RESOLUTION_ERROR };
}

export function isStrictWasmModule(
  _module: WasmRuntimeModule | null,
): _module is WasmRuntimeModule {
  return false;
}

const BROWSER_RESOLUTION_ERROR =
  "the synchronous Node WASM loader is unavailable in browser builds; use engine='ts'";

/**
 * Browser builds deliberately use the TypeScript engine. The current
 * wasm-pack artifact is CommonJS/Node-targeted and cannot be loaded
 * synchronously in a browser without changing the public Runtime constructor.
 */
export function resolveWasmModule(
  _options: ResolveWasmModuleOptions = {},
): WasmRuntimeModule | null {
  return null;
}

export function wasmModuleResolutionErrors(): string[] {
  return [BROWSER_RESOLUTION_ERROR];
}

export function resetWasmModuleCache(): void {
  // Browser builds do not maintain a Node module cache.
}

export function wasmModuleCandidates(modulePath?: string): string[] {
  return modulePath ? [modulePath] : [];
}
