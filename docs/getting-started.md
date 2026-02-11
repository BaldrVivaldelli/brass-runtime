# 🧵 Brass Runtime — Getting Started

`brass-runtime` es un runtime funcional y cooperativo para JavaScript/TypeScript inspirado en modelos como **ZIO**, **Effect** y **structured concurrency**.

Su objetivo es permitir escribir lógica **pura, cancelable y composable**, sin perder la posibilidad de ejecutarla fácilmente desde código imperativo.

---

## 📦 Instalación

```bash
npm install brass-runtime
```



## 🧠 Conceptos clave

### `Async<R, E, A>`
Un `Async` representa un **cálculo perezoso** que:

- puede requerir un entorno (`R`)
- puede fallar con un error (`E`)
- puede producir un valor (`A`)
- **no se ejecuta automáticamente**

Nada corre hasta que vos lo pedís explícitamente.

---

## 🚀 Ejemplo rápido

```ts
import { makeHttp } from "brass-runtime/http";
import { toPromise } from "brass-runtime";

const http = makeHttp({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

async function main() {
  const effect = http.get("/posts/1");

  const result = await toPromise(effect, {});
  console.log(result.status);
  console.log(result.bodyText);
}

main();
```

---

## 🧩 ¿Por qué `toPromise`?

`toPromise` es el **puente entre el mundo funcional y el mundo imperativo**.

- `Async` es perezoso → no ejecuta nada por sí solo
- `toPromise` ejecuta el efecto en el runtime
- devuelve una `Promise` estándar

```ts
const result = await toPromise(effect, env);
```

Internamente:
- crea un *fiber*
- lo ejecuta en el scheduler
- espera el resultado
- lo transforma en `Promise`

---

## ⚙️ Estructura mental del runtime

```
Async  --->  Fiber  --->  Scheduler  --->  Resultado
   |            |            |
   |            |            +-- controla ejecución
   |            +-- maneja estado y cancelación
   +-- describe el cómputo
```

Nada se ejecuta hasta que:
```ts
toPromise(effect, env)
```

---

## 🌐 Ejemplo HTTP completo

```ts
import { makeHttp } from "brass-runtime/http";
import { toPromise } from "brass-runtime";

const http = makeHttp({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

async function main() {
  const effect = http.get("/posts/1");

  const result = await toPromise(effect, {});
  console.log("Status:", result.status);
  console.log("Body:", result.bodyText);
}

main();
```

---

## 🧩 ¿Por qué no usar `fetch` directamente?

Porque `Async` te da:

- Cancelación estructurada
- Composición funcional
- Control explícito de ejecución
- Testing determinístico
- Integración con fibras y scopes

---

## 🧠 Regla de oro

> **Los efectos no se ejecutan solos.**  
> Se describen con `Async`, y se ejecutan solo con `toPromise` (o un runner equivalente).

---

## 🧪 Testing

```ts
import { toPromise } from "brass-runtime";

test("fetch works", async () => {
  const result = await toPromise(http.get("/posts/1"), {});
  expect(result.status).toBe(200);
});
```

---

## 🧭 Próximos pasos

- Composición (`map`, `flatMap`)
- Cancelación con `AbortSignal`
- `race`, `timeout`, `retry`
- Integración con React / Bun / Workers


---

## Next

- Learn how interruption and `Scope` work: [Cancellation & interruption](./cancellation.md)
- Enable logging/tracing with hooks: [Observability](./observability.md)
