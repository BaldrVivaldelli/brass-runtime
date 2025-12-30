# 🛠️ brass-runtime — Mini runtime funcional al estilo ZIO en TypeScript

**brass-runtime** es un runtime funcional inspirado en **ZIO 2**, escrito en **TypeScript vanilla** y **sin usar Promises ni async/await** como primitiva principal de modelado.

El objetivo del proyecto es explorar cómo construir, desde cero, un sistema de:

- **Efectos puros** (sincrónicos y asincrónicos)
- **Concurrencia estructurada**
- **Fibras** (fibers)
- **Scheduler cooperativo**
- **Limpieza segura de recursos (acquire / release)**
- **Scopes estructurados**
- **Finalizers (a nivel scope y fibra)**
- **Streams estructurados (ZStream-like) con backpressure**

Todo con un diseño **determinístico**, **pure FP**, y sin depender de `Promise` ni `async/await` para la semántica del modelo.

---

## ✨ Características principales

### 1. `Effect` sincrónico (núcleo funcional)

En `brass-runtime`, un efecto puro se modela como:

```ts
type Exit<E, A> =
  | { _tag: "Success"; value: A }
  | { _tag: "Failure"; error: E };

type Effect<R, E, A> = (env: R) => Exit<E, A>;
```

Con combinadores típicos de un sistema de efectos:

- `map`
- `flatMap`
- `mapError`
- `catchAll`
- `zip`
- `foreach`
- `collectAll`
- `as`, `asUnit`, `tap`

Este núcleo no usa `Promise` ni `async/await`. Es **100% sincrónico y determinista**.

---

### 2. `Async` — efectos asincrónicos sin Promises

Para modelar operaciones asincrónicas, `brass-runtime` define un tipo de datos algebraico:

```ts
type Async<R, E, A> =
  | { _tag: "Succeed"; value: A }
  | { _tag: "Fail"; error: E }
  | { _tag: "Sync"; thunk: (env: R) => A }
  | { _tag: "Async"; register: (env: R, cb: (exit: Exit<E, A>) => void) => void }
  | { _tag: "FlatMap"; first: Async<R, E, any>; andThen: (a: any) => Async<R, E, A> };
```

Con constructores como:

- `asyncSucceed`
- `asyncFail`
- `asyncSync`
- `asyncTotal`
- `async` (primitive para integrar APIs callback-based como `setTimeout`, `fs`, etc.)
- `asyncMap`
- `asyncFlatMap`

Y un runtime que ejecuta `Async` mediante un **intérprete explícito**, sin usar `Promise`.

---

### 3. Scheduler cooperativo

El sistema usa un **scheduler cooperativo** con una cola de tareas:

```ts
class Scheduler {
  schedule(task: () => void): void;
}
```

El `Scheduler` controla:

- el orden en que se ejecutan los pasos de cada fibra,
- la equidad (fairness),
- posibles políticas de prioridad.

Esto permite testear y razonar sobre la concurrencia sin depender del azar del event loop.

---

### 4. Fibers (fibras)

Cada programa `Async` corre dentro de una **fibra**:

```ts
type Fiber<E, A> = {
  id: number;
  status: () => "Running" | "Done" | "Interrupted";
  join: (cb: (exit: Exit<E | Interrupted, A>) => void) => void;
  interrupt: () => void;
  addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => Async<any, any, any>) => void;
};
```

Las fibras proveen:

- concurrencia liviana (miles de fibers),
- cancelación cooperativa (`interrupt`),
- `join` para esperar resultados,
- **finalizers de fibra** (LIFO) que se ejecutan siempre: éxito, fallo o interrupción.

---

### 5. Scopes — Concurrencia estructurada

Un **Scope** modela una unidad de concurrencia estructurada:

```ts
class Scope<R> {
  fork<E, A>(eff: Async<R, E, A>, env: R): Fiber<E, A>;
  subScope(): Scope<R>;
  addFinalizer(f: (exit: Exit<any, any>) => Async<R, any, any>): void;
  close(exit?: Exit<any, any>): void;
  isClosed(): boolean;
}
```

Un scope:

- rastrea las fibras hijas,
- rastrea sub-scopes,
- mantiene una pila de finalizers (LIFO),
- al cerrarse:
    - interrumpe fibras hijas,
    - cierra sub-scopes,
    - ejecuta finalizers registrados.

Esto da **concurrencia estructurada** al estilo ZIO:
si algo vive en un `Scope`, se limpia cuando el scope termina.

---

### 6. Acquire / Release — Resource Safety

Al estilo `ZIO.acquireRelease`, `brass-runtime` implementa:

```ts
acquireRelease(
  acquire: Async<R, E, A>,
  release: (res: A, exit: Exit<any, any>) => Async<R, any, any>,
  scope: Scope<R>
): Async<R, E, A>;
```

Semántica:

- `acquire` corre dentro del scope,
- si tiene éxito, registra un finalizer que hace `release(res, exitFinalDelScope)`,
- el finalizer se ejecuta:
    - si el scope cierra con éxito,
    - si hay error,
    - si hay interrupción/cancelación.

**Garantiza cleanup de recursos** (archivos, sockets, conexiones, etc.) de forma estructurada.

---

### 7. Structured Concurrency: `race`, `zipPar`, `collectAllPar`

Sobre fibras, scopes y `Async`, se construyen combinadores de **concurrencia estructurada**:

#### `race(left, right, scope)`

- ejecuta `left` y `right` en paralelo dentro de un scope,
- el primero que termina “gana”,
- la fibra perdedora se interrumpe,
- se propaga el resultado del ganador.

#### `zipPar(left, right, scope)`

- ejecuta ambos efectos en paralelo,
- si alguno falla → se cancela el otro,
- si ambos tienen éxito → devuelve `[A, B]`.

#### `collectAllPar(effects, scope)`

- ejecuta una lista de efectos en paralelo,
- si alguno falla → cancela el resto,
- si todos completan → devuelve la lista de resultados.

Esto replica la semántica de **ZIO 2 structured concurrency**.

---

### 8. ZStream-like — Streams estructurados con backpressure

`brass-runtime` incluye una base de **streams estructurados** inspirados en `ZStream`:

```ts
type Pull<R, E, A> = Async<R, Option<E>, A>;

type ZStream<R, E, A> = {
  open: (scope: Scope<R>) => Pull<R, E, A>;
};
```

Donde:

- `Success(a)` → el stream produjo un valor,
- `Failure(Some(e))` → error,
- `Failure(None)` → fin del stream.

Constructores básicos:

- `empty`
- `streamOf`
- `fromArray`

Transformaciones:

- `map`
- `filter`
- `fromResource` (integra acquire/release con streams)

Consumo:

```ts
runCollect(stream, env): Async<R, E, A[]>;
```

El consumo se hace respetando backpressure: cada `pull` produce como mucho un valor,
y el scope del stream garantiza que todos los recursos/finalizers se limpien al terminar
(el stream o el consumidor).

---

## 📁 Estructura sugerida del proyecto

Una posible organización de archivos para tu repo de **brass-runtime**:

```bash
src/
  fibers/    
  scheduler/    
  stream/
  types/
    

examples/
  demo.ts
  fiberFinalizer.ts
  resourceExample.ts
```

---

## 🚀 Ejemplo rápido

```ts
import {
  asyncTotal,
  asyncFlatMap,
  asyncSucceed,
} from "./asyncEffect";
import { sleep } from "./std";
import { Scope } from "./scope";
import { race } from "./concurrency";

type Env = {};

function task(name: string, ms: number) {
  return asyncFlatMap(sleep(ms), () =>
    asyncSucceed(`Terminé ${name}`)
  );
}

function main() {
  const env: Env = {};
  const scope = new Scope<Env>();

  const fast = task("rápida", 200);
  const slow = task("lenta", 1000);

  race(fast, slow, scope)(env, exit => {
    console.log("Resultado race:", exit);
    scope.close(exit);
  });
}

main();
```

---

## 🧪 Objetivos del proyecto

- Explorar el diseño de runtimes funcionales modernos (tipo ZIO) en TypeScript.
- Entender y practicar:
    - Efectos tipados (`R`, `E`, `A`),
    - Concurrencia estructurada,
    - Fibras,
    - Scopes y finalizers,
    - Streams con recursos seguros y backpressure.
- Servir como base educativa y potencialmente como **runtime experimental**
  para proyectos de ejemplo, demos y pruebas de conceptos FP en TS.

---

## 📝 Estado actual

- [x] Núcleo de efectos sincrónicos (`Effect`)
- [x] Núcleo de efectos asincrónicos (`Async`) sin Promises
- [x] Scheduler cooperativo
- [x] Fibers con finalizers
- [x] Scopes con finalizers (LIFO)
- [x] Acquire / Release
- [x] Concurrencia estructurada (`race`, `zipPar`, `collectAllPar`)
- [x] Streams básicos (`ZStream`-like) con backpressure y scopes
- [ ] Buffering en streams
- [ ] Merge / zipPar de streams
- [ ] Hubs / Broadcast / Multicast
- [ ] Pipelines (tipo `ZPipeline`)
- [ ] Channels / Sinks avanzado

---

## 📜 Licencia

Este proyecto está pensado como laboratorio de ideas FP.
Se recomienda usar licencia MIT:

```text
MIT License
Copyright (c) 2025
```

---

## 🤝 Contribuciones

Ideas de mejora, PRs y discusiones de diseño son más que bienvenidas.

Algunas direcciones interesantes para futuro:

- Integrar fs / net de Node de forma segura vía `Async`,
- Agregar tests deterministas de concurrencia,
- Implementar Hubs y Queues al estilo ZIO,
- Extender ZStream con merges, buffers y pipelines,
- Explorar integración con TypeScript decorators para “endpoints” basados en efectos.

---

Hecho con ❤️ en TypeScript, para aprender y jugar con runtimes funcionales.

**Nombre del proyecto:** `brass-runtime`  
**Objetivo:** construir un mini ZIO-like runtime en el ecosistema JS/TS, pero manteniendo el control total sobre la semántica de los efectos desde el código de usuario.
