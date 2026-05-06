export type EngineKind = "ts" | "wasm";

export type EngineStats<T> = {
  engine: EngineKind;
  data: T;
  fallbackUsed: false;
};

export type EngineSelectionMode = EngineKind;

export type EngineSelection<T> = EngineStats<T> & {
  requested: EngineSelectionMode;
};

export function engineStats<T>(
  engine: EngineKind,
  data: T,
): EngineStats<T> {
  return { engine, data, fallbackUsed: false };
}

export function selectedEngineStats<T>(
  requested: EngineSelectionMode,
  engine: EngineKind,
  data: T
): EngineSelection<T> {
  if (requested !== engine) {
    throw new Error(`brass-runtime strict engine mismatch: requested '${requested}', got '${engine}'`);
  }
  return { requested, engine, data, fallbackUsed: false };
}
