# Brass Runtime WASM Fiber Engine

Este repo mantiene la estructura original de `brass-runtime`: el package se publica desde la raíz del repositorio, no desde `packages/brass-runtime`.

## Qué cambió

Se agregó un engine interno experimental para mover el estado de suspensión de las fibras hacia un bridge WASM:

- `src/core/runtime/engine/types.ts`: contrato `FiberEngine`.
- `src/core/runtime/engine/JsFiberEngine.ts`: fallback JS que usa el `RuntimeFiber` actual.
- `src/core/runtime/engine/WasmFiberEngine.ts`: engine experimental JS/WASM.
- `src/core/runtime/engine/opcodes.ts`: representación interna del `Async` actual como plan/opcodes.
- `src/core/runtime/engine/bridge/ReferenceWasmBridge.ts`: bridge de referencia, sin compilar Rust, útil para tests locales.
- `src/core/runtime/engine/bridge/WasmPackFiberBridge.ts`: adapter para el output de `wasm-pack`.
- `src/core/runtime/hostAction.ts`: efectos host declarativos HTTP/DB/Queue/custom.
- `crates/brass-runtime-wasm-engine`: crate Rust/WASM.
- `src/core/runtime/bench/heap-per-suspended-fiber.ts`: benchmark de heap por fibra suspendida.

## Uso

El modo por defecto sigue siendo JS:

```ts
const runtime = Runtime.make({});
```

Modo experimental sin compilar Rust:

```ts
const runtime = new Runtime({
  env: {},
  engine: "wasm-reference",
});
```

Modo WASM real:

```ts
const runtime = new Runtime({
  env: {},
  engine: "wasm",
});
```

## Host actions declarativas

```ts
import { Runtime, fromHostAction } from "brass-runtime";

const runtime = new Runtime({
  env: {},
  engine: "wasm-reference",
  hostExecutor: {
    async execute(action, ctx) {
      // Acá vive fetch/axios/db/queue real.
      return { kind: "ok", value: { ok: true } };
    },
  },
});

const result = await runtime.toPromise(
  fromHostAction({ kind: "custom", target: "my-side-effect" })
);
```

Con `fromPromiseAbortable`, la closure host sigue viviendo en JS porque Axios/fetch/DB viven en Node. El engine WASM reduce la parte de continuación/scheduler/fiber state de Brass. Para reducir más heap por suspensión, usá `fromHostAction`, que representa el efecto como acción declarativa y deja el side effect real en el `HostExecutor`.

## Publicación desde este repo

```bash
npm install
npm run build
npm pack --dry-run
npm publish
```

Si querés publicar con el `.wasm` real incluido:

```bash
cargo --version
wasm-pack --version
npm run build:wasm
npm run build
npm pack --dry-run
npm publish
```

## Benchmark

```bash
npm run benchmark heap-suspended-fiber
```

The direct benchmark script is still available when you want a specific engine
or longer suspension window:

```bash
node --expose-gc ./node_modules/.bin/tsx src/core/runtime/bench/heap-per-suspended-fiber.ts \
  --engine wasm \
  --mode host-action \
  --fibers 10000 \
  --delayMs 2000
node --expose-gc ./node_modules/.bin/tsx src/core/runtime/bench/heap-per-suspended-fiber.ts --engine ts --mode closure
```

## WASM fiber registry + wakeups

The WASM engine now also owns a compact `BrassWasmFiberRegistry` used by the TS engine facade to track fiber lifecycle metadata and coalesce wakeups.

The public TypeScript `Runtime` API is unchanged. When `engine: "wasm"` is selected:

- TS still executes host callbacks, promises, finalizers and Node integrations.
- Rust/WASM tracks fiber states: queued, running, suspended, done, failed and interrupted.
- Rust/WASM owns a wakeup queue so repeated wakeups for the same fiber are coalesced before TS schedules more work.
- `runtime.stats().fiberRegistry` exposes registry counters for observability.

This keeps the high-level Brass API ergonomic while moving another hot coordination path into a compact Rust state machine.
