export type EngineKind = "js" | "wasm";

export type EngineStats<T> = {
  engine: EngineKind;
  data: T;
  fallbackUsed: boolean;
};

export type EngineSelectionMode = "auto" | EngineKind;

export type EngineSelection<T> = EngineStats<T> & {
  requested: EngineSelectionMode;
};

export function engineStats<T>(
  engine: EngineKind,
  data: T,
  fallbackUsed: boolean = false
): EngineStats<T> {
  return { engine, data, fallbackUsed };
}

export function selectedEngineStats<T>(
  requested: EngineSelectionMode,
  engine: EngineKind,
  data: T
): EngineSelection<T> {
  return { requested, engine, data, fallbackUsed: requested === "auto" && engine !== "wasm" };
}
