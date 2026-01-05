# agent.md — brass-runtime

> Objetivo: que un LLM pueda orientarse rápido en este repo y hacer cambios sin romper las **invariantes semánticas** (no-Promise core, cancelación estructurada, cleanup determinístico).

## Qué es este proyecto (TL;DR)

`brass-runtime` es un runtime experimental “mini ZIO-like” en TypeScript:
- Effects como valores (lazy, composables, referentially transparent)
- Async **explícito** (la semántica no se apoya en `Promise` / `async` / `await`)
- Concurrencia estructurada con **fibers + scopes + finalizers**
- Scheduler cooperativo (ejecución “por pasos”)
- Streams estilo ZStream con backpressure

Este repo es “la base” (runtime + primitivas). Los módulos “de más alto nivel” se construyen **encima** (ej: HTTP), no se bakean en el core.

---

## Layout del repo (orientativo)

- `src/`  
  Implementación del runtime y librerías “encima” (ej: HTTP, streams, etc).
    - `src/examples/` contiene ejemplos (p. ej. integraciones y streams).
- `docs/`  
  Documentación/guías (Getting Started, etc).
- Build/config:
    - `tsup.config.ts` (bundle/build)
    - `tsconfig.*.json` (base + ESM/CJS/types)
- Release:
    - `.releaserc.json` + `CHANGELOG.md` (release automation / changelog)

> Nota: si necesitás ubicar algo rápido, buscá por keywords (ver sección “Mapa mental / keywords”).

---

## Invariantes (las “reglas de oro”)

### 1) No Promises como semántica core
- Evitá introducir `Promise` como *unidad de ejecución* del runtime.
- Las integraciones con el ecosistema JS pueden usar Promises internamente, pero deben “puentearse” a `Async` (ver patrones).

### 2) Laziness: no ejecutar efectos al construirlos
- Si integrás algo que retorna `Promise`, preferí tomar un **thunk** `() => Promise<A>` y no el `Promise<A>` ya creado.
- No disparar side-effects en construcción (solo cuando el fiber lo corre).

### 3) Cancelación coherente y cleanup determinístico
- Si una operación puede cancelarse, integrala con finalizers/AbortController.
- Cuando un fiber se interrumpe o un scope se cierra:
    - se cancelan hijos
    - se corren finalizers (idealmente LIFO)
    - se liberan recursos (via `Scope` / `acquireRelease`)

### 4) Mantener el core pequeño
- Si vas a sumar features: preferí sumarlas como **librería encima del runtime** (middleware/funciones), no como magia dentro del core.

---

## Conceptos clave (mapa semántico)

> (Los nombres exactos pueden variar por archivo, pero el modelo es este.)

- `Exit<E, A>`: resultado de computación (Success/Failure).
- `Effect<R, E, A>`: core sincrónico (determinístico).
- `Async<R, E, A>`: ADT que modela async explícito (incluye `register` callback).
- `Scheduler`: corre trabajo cooperativo.
- `Fiber`: unidad de ejecución de `Async`; soporta `join`, `interrupt`, y finalizers.
- `Scope`: estructura de concurrencia + ownership de recursos; cerrar scope cancela y limpia.
- `acquireRelease`: patrón de resource safety.
- `ZStream` / streams: pull-based, backpressure, cleanup determinístico.

---

## Patrones de integración con ecosistema JS (LEGO blocks)

### A) Node-style callbacks → Async
Patrón: convertir `(err, value) => void` a `Async`.
- Ideal para `fs`, `child_process`, etc.

Checklist:
- Mapear error a `Exit Failure`
- Mapear ok a `Exit Success`
- Si aplica cancelación: registrar cleanup (remove listener, abort, clearTimeout, etc.)

### B) Promises → Async (lazy)
Patrón: `fromPromise(() => promise)` (thunk).
- Preserva laziness.

Checklist:
- NUNCA pasar `Promise` ya creado si eso dispara trabajo eagerly.
- Capturar `.then/.catch` y traducir a `Exit`.

### C) Promises cancelables → Async + finalizer
Patrón: `fromPromiseAbortable((signal) => promise)` usando `AbortController`.
- El `register` devuelve un finalizer que llama `abort()`.

Checklist:
- Cuando el error sea abort/interrupt: traducirlo a “Interrupted” (o el tipo de interrupción que use el runtime).
- Asegurar que el finalizer sea idempotente (abort múltiple ok).

### D) Event emitters / listeners → Async + cleanup
Patrón: `fromEvent(target, eventName)`:
- Registrar handler
- Devolver finalizer para remover handler al interrumpir/cerrar scope

### E) Node streams → ZStream (resource-aware)
- `acquireRelease` para crear/destroy stream
- Buffer/cola intermedia para backpressure
- Cleanup SIEMPRE (destroy)

---

## HTTP layer (brass-http) — cómo pensarla
El cliente HTTP “core” debe ser algo tipo:
- `HttpClient: (req) => Async<_, HttpError, HttpWireResponse>`

Y luego encima:
- decoding (text/json) como funciones “map” sobre wire response
- middleware (logging, retry, timeout, meta/tracing) como composición, no como fields pegados a tipos base

---

## Cómo trabajar en este repo (para LLMs)

### Antes de cambiar código
1) Buscá “el tipo” que estás tocando:
    - `type Async<` / `type Effect<` / `class Scope` / `class Scheduler` / `Fiber`
2) Identificá si el cambio afecta:
    - laziness
    - cancelación/interrupción
    - orden/garantía de finalizers
    - resource safety (`acquireRelease`, scopes)
3) Preferí sumar helpers/funciones encima del core antes que tocar el core.

### Al implementar features nuevas
- Si es “ecosystem integration”: agregá un *bridge* (`fromCallback`, `fromPromiseAbortable`, etc.) y un ejemplo.
- Si es “operator” (race/timeout/retry): escribilo como combinador puro sobre `Async`.
- Si es “resource”: usá `acquireRelease` + scope y escribí el release en forma total (no tirar).

### Al arreglar bugs
- Repro con un ejemplo mínimo en `src/examples/` (ideal).
- Validar:
    - ¿se cancela correctamente?
    - ¿se ejecuta cleanup al perder un `race`?
    - ¿se liberan recursos cuando se cierra un `Scope`?

---

## Mapa mental / keywords para navegar rápido
Usá estas strings en búsqueda global:
- `Async<` / `_tag: "Async"` / `register`
- `Effect<`
- `Exit` / `_tag: "Success"` / `_tag: "Failure"`
- `Interrupted` / `interrupt`
- `Fiber` / `join` / `addFinalizer`
- `Scope` / `subScope` / `close` / `isClosed`
- `acquireRelease`
- `Scheduler` / `schedule`
- `ZStream` / `Pull` / `buffer` / `Hub` / `Broadcast`
- `toPromise` (helper DX para ejemplos)
- `AbortController` / `AbortSignal`

---

## Comandos (ver `package.json` para exactitud)
Sugerencia típica:
- instalar deps: `npm install` (o `npm ci`)
- build: `npm run build`
- test/lint: `npm test` / `npm run lint` (si existen)
- ejecutar ejemplos: revisar scripts o correr con tu runner (tsx/ts-node/bun/deno según setup)

> Regla: no asumas scripts; confirmá mirando `package.json`.

---

## “No romper esto” (pitfalls comunes)
- ❌ Introducir `await`/`Promise` en caminos semánticos del core.
- ❌ Ejecutar side-effects al construir un `Async`/`Effect` en vez de al correrlo.
- ❌ Integraciones sin finalizer (event listeners, timeouts, sockets, fetch abortable).
- ❌ Mezclar “wire” con “decoding” (especialmente en HTTP): mantené capas.
- ❌ Agregar estado global oculto: preferí `Scope` y env explícito.

---

## Cómo escribir PRs útiles
- Cambios chicos y focalizados.
- Si es integración: agregar un ejemplo mínimo.
- Si toca cancelación/cleanup: explicar el caso de interrupción (qué se cancela y cuándo).
