# Informe de arquitectura y ruta nativa para VS Code

**Fecha:** 2026-07-21

**Alcance:** revisión estática de `brass-runtime` (TypeScript, Rust/WASM, empaquetado, pruebas, documentación, agent y extensión de VS Code). No se modificó código de producto.

## Resumen ejecutivo

`brass-runtime` ya es más que un runtime de efectos: reúne un núcleo de concurrencia estructurada, streams, HTTP de producción, schema sin dependencias, observabilidad, profiling y un agente con CLI y extensión de VS Code. La dirección de dependencias está explícitamente protegida (`core` no conoce a HTTP ni al agent) y el proyecto posee una base de pruebas amplia, con pruebas de propiedades en las zonas donde más importan las invariantes.

La mayor oportunidad no es una reescritura en Rust. Es convertir las fronteras actuales —que hoy son en buena medida internas— en contratos estables y medibles. El motor WASM ya desplaza a Rust parte del estado y coordinación de fibras, colas, scheduler, temporizadores y chunks; TypeScript sigue correctamente como dueño de closures, Promises, `AbortController`, finalizadores e integraciones Node. Esa división debe mantenerse para el runtime web/Node. Para un fork de VS Code, el camino más sólido es añadir un servicio nativo Rust aislado para operaciones intensivas y de larga vida, con IPC versionado, y conservar la UX, API de extensiones y políticas en TypeScript.

Prioridad recomendada:

1. Estabilizar y medir la frontera WASM/TypeScript antes de mover más lógica.
2. Extraer contratos de plataforma para el agent y preparar IPC local, sin acoplarse a VS Code internamente.
3. Crear un piloto Rust nativo pequeño y medible para el fork, no una migración total del runtime.
4. Adoptar solo las piezas nativas que ganen frente a TypeScript con métricas reproducibles de latencia, CPU y memoria.

## Evidencia revisada

- `package.json` publica subpaths para core, HTTP, schema, observabilidad, perf y agent; incluye CJS, ESM, tipos y los artefactos WASM.
- El código fuente de producción revisado suma aproximadamente: core 16k líneas, HTTP 15k, agent 12.5k, observabilidad 5.2k, perf 3.7k y schema 0.6k. Hay 229 archivos de pruebas TypeScript identificados.
- Las invariantes documentadas definen efectos perezosos, cancelación cooperativa e idempotente, ownership por scopes, finalizadores exactamente una vez y separación de HTTP/agent respecto del core.
- El crate `crates/brass-runtime-wasm-engine` es un crate WASM único (`wasm-bindgen`, `serde`, `js-sys`). El output `wasm/pkg` no está versionado: es correctamente un artefacto de build.
- El test de paridad del engine compara efectos básicos TS/WASM solo cuando WASM está disponible. Otras pruebas del engine usan bridges falsos para cubrir ramas de la fachada TypeScript.
- La extensión `extensions/vscode-brass-agent` hoy es una extensión convencional: compila TypeScript y lanza el CLI `brass-agent` como proceso hijo. No existe aún un protocolo de servicio interno para un fork.

## Arquitectura actual

```text
                 schema (sin dependencias)
                          ↑
 root/core ── runtime, fibers, scopes, scheduler, streams
       ↑                 ↑
 HTTP ───────────── observabilidad ───── perf
       ↑
 agent core ── adaptadores Node/LLM/herramientas ── CLI ── extensión VS Code

 runtime TS ── bridge ABI ── motor Rust/WASM
```

La dirección descrita es sana: los consumidores de alto nivel dependen del core, pero el core no depende de ellos. `Layer`, recursos y scopes proporcionan un vocabulario común para ownership y ciclo de vida. La parte de mayor coste de comprensión es el tamaño de las superficies públicas: el root conserva compatibilidad y expone muchas categorías, mientras que los subsistemas ya tienen subpaths más claros.

## Evaluación por área

### Core, fibras y scheduler

**Fortalezas**

- El modelo `Async` perezoso, fibers, scopes y finalizadores está claramente especificado y tiene pruebas unitarias y de propiedades para leyes de composición, scheduler, colas y causas.
- La cancelación está conectada a ownership estructurado, no tratada como un callback aislado. Es la base correcta para HTTP, agent y una futura integración editor/host.
- Hay engines explícitos y modo WASM estricto: pedir WASM sin disponibilidad no degrada silenciosamente a TS.

**Mejoras**

1. Declarar una tabla de madurez para APIs de core (`estable`, `experimental`, `interna`) y limitar las nuevas exportaciones del root. Promover `brass-runtime/core` como import recomendado y deprecar de forma documentada solo después de una ruta de migración.
2. Definir un contrato de diagnóstico compacto y estable: conteo de fibras vivas/suspendidas, scopes pendientes, cola por lane, duración de finalizadores y causas de interrupción. Debe poder consumirse sin habilitar hooks costosos.
3. Añadir pruebas de modelo que mezclen scope padre/hijo, interrupción, reanudación async y finalizadores contra ambos engines. La paridad actual cubre semánticas básicas, pero no representa todavía todo el ciclo de vida estructurado.
4. Establecer presupuestos de rendimiento por versión para costo de `fork`, suspensión, reanudación, tamaño por fibra suspendida y fairness de lanes.

### Streams

**Fortalezas:** streams pull-based, colas/hubs/buffers, backpressure y pruebas de orden/cancelación/fusión ya están separados del core de efectos.

**Mejoras:** publicar una matriz de comportamiento por estrategia de buffer (bloqueo, drop, sliding), instrumentar ocupación/espera y probar cancelación con consumidores lentos y cierre simultáneo. Para VS Code, los streams deben ser el mecanismo preferido para eventos del servicio nativo, con límites de buffer explícitos para no bloquear renderer ni extension host.

### HTTP y schema

**Fortalezas**

- HTTP está bien estratificado: transporte, política de request, lifecycle, retry, cache/dedup/batch/prioridad, compresión, prewarm, limiter, servidor y validación.
- `schema` es first-party, pequeño y sin dependencias; la validación de config en construcción reduce errores tardíos.
- Las políticas por request concentran knobs que antes podían dispersarse entre middleware.

**Mejoras**

1. Reducir la carga cognitiva de HTTP con tres perfiles documentados y observables: interactivo/editor, servicio estándar y proxy. Cada perfil debe mostrar límites, retry, cache, prioridad y observabilidad efectivos.
2. Formalizar compatibilidad de middleware: orden, ownership de cancelación, mutabilidad permitida de headers/body y claves de cache/dedup. Mantener tests de composición por pares para middleware que compartan estado.
3. Añadir pruebas de contrato para transportes externos Promise/Axios/undici y aborts reales. La normalización de errores es valiosa pero sensible a formas externas cambiantes.
4. No mover HTTP a Rust por defecto. Fetch, proxies, credenciales, cookies y aborts siguen siendo del host. Solo evaluar una implementación nativa para un futuro daemon si las métricas muestran que el transporte Node es el cuello de botella.

### Observabilidad y perf

**Fortalezas:** hay exportadores backend-neutral, límites de cardinalidad, redacción, sampling y un profiler con historial, baseline y presupuestos. Es una base excelente para decidir, no asumir, la utilidad de WASM o Rust.

**Mejoras:** unificar en un único formato de evento versionado los diagnósticos de runtime, agent y servicio nativo. Añadir trazas de frontera (TS→WASM, TS→IPC, IPC→Rust) con duración, bytes, cola y resultado, sin incluir prompts, paths sensibles ni secretos. Integrar benchmarks WASM reales en CI opcional con artefactos de referencia; hoy la documentación los contempla, pero dependen del toolchain local.

### Agent, CLI y extensión actual

**Fortalezas**

- Las acciones pasan por permisos, aprobación, política, `Async` y reducer; las rutas de workspace se validan dentro de política.
- El agent se conserva explícitamente experimental y fuera del core. Esto permite evolucionar UX sin comprometer el runtime.
- La extensión ya ofrece comandos, chat, historial, secretos de VS Code y cancelación del proceso hijo.

**Mejoras**

1. Extraer una interfaz `AgentHost` independiente de Node: filesystem, búsqueda, shell, secretos, diagnósticos, modelo, telemetría y lifecycle. Los adaptadores actuales Node y VS Code deben implementarla; el core del agent no debe importar `vscode`.
2. Reemplazar el transporte implícito de stdout/proceso hijo por un protocolo explícito JSON-RPC o mensajes binarios versionados. Conservar el CLI como adaptador para terminales y modo degradado.
3. Modelar las aprobaciones como capacidades de corta vida (scope, operación, expiración, hash del patch), no como un booleano de UI. El servicio nativo nunca debe poder saltar ese control.
4. Separar estado efímero por sesión del estado persistido por workspace y versionar ambos formatos. El historial actual puede crecer y el patch completo no debería persistirse sin retención, cifrado local opcional y redacción.

### Empaquetado, documentación y calidad

**Fortalezas:** los exports están declarados, existe validación CJS, matriz de validaciones por área y una guía de invariantes accionable.

**Mejoras:** crear un workspace Rust formal si crecen los crates, pinnear toolchain Rust/wasm-pack en CI, generar SBOM/licencias y publicar checksums de artefactos WASM/nativos. Añadir un changelog de compatibilidad para ABI y protocolo. No hay script de lint declarado en el paquete principal; decidir si se adopta ESLint/Biome o si `tsc` + tests es la política deliberada y documentarla.

## Foco Rust/WASM

### Estado real

El motor Rust/WASM ya implementa más que una demostración: VM de fibras basada en opcodes, registro de fibras, wakeups coalescidos, ready queue por lanes, timer wheel, ring buffer y buffer de chunks. El bridge TypeScript serializa programas y conserva referencias a funciones/valores del host. Hay ABI binario y rutas JSON, métricas y slab de fibras. El modo WASM es estricto, una decisión correcta para no ocultar diferencias semánticas.

Sin embargo, el crate aún tiene una responsabilidad muy amplia en un único `lib.rs`, usa `JsValue` y `serde_json` en rutas que pueden implicar crossings/allocations, y no muestra pruebas Rust nativas ni un workspace/toolchain Rust fijado. La paridad funcional está validada principalmente desde Vitest y parte de las pruebas usa bridges falsos: útil para la integración TS, insuficiente como evidencia de equivalencia end-to-end del binario WASM.

### Frontera recomendada

Mantener en TypeScript:

- ejecución de closures, Promises, `AbortSignal`, APIs Node/Electron/VS Code;
- finalizadores que liberan recursos del host;
- shape pública de `Async`, errores tipados y ergonomía de librería;
- políticas, permisos y decisiones de producto.

Mover o consolidar en Rust/WASM solo si hay medición favorable:

- estado compacto de fibers suspendidas y continuaciones serializables;
- colas acotadas, registro de fibers, selección fair de lanes, temporizadores y buffers de stream;
- codificación/decodificación binaria validada de programas declarativos;
- agregación local de métricas de muy alta frecuencia.

No mover aún closures arbitrarias, HTTP host, LLM, filesystem, decisiones de permisos ni `Scope` completo. Esas áreas exigen callbacks y recursos del host; su migración aumentaría crossings y complejidad sin una ganancia demostrada.

### Plan técnico Rust/WASM

1. **Inventario y clasificación (P0).** Catalogar módulos Rust/WASM y TypeScript, dependencias, efectos y datos; asignarlos a núcleo portable, host, UX o autorización. **Entregable:** matriz de propietarios. **Depende de:** nada. **Salida:** el 100 % de las rutas candidatas tiene propietario y host, UX y autorización quedan en TypeScript.
2. **Frontera de responsabilidades (P0).** Aprobar coordinación, colas, planificación y transformaciones de datos deterministas para el núcleo; excluir filesystem, red, LLM, credenciales, permisos y closures arbitrarias. **Entregable:** especificación de frontera. **Depende de:** paso 1. **Salida:** ninguna operación del núcleo requiere una API o permiso del host.
3. **Contrato ABI versionado (P0).** Especificar endianness, tamaños, opcodes, sentinels, límites, errores y compatibilidad; exponer `abi_version`, `engine_version` y capacidades negociables. **Entregable:** documento ABI y handshake. **Depende de:** paso 2. **Salida:** el bridge rechaza una versión mayor desconocida y registra la menor versión compatible.
4. **Modelo de datos canónico (P0).** Fijar tipos y serialización estables para solicitudes, resultados, diagnósticos, métricas y cancelaciones, con límites de tamaño. **Entregable:** esquema y fixtures binarios/JSON versionados. **Depende de:** paso 3. **Salida:** cada fixture se codifica y decodifica sin pérdida en TypeScript y Rust.
5. **Umbrales de promoción (P0).** Definir baselines: paridad del 100 %; cero fallbacks no esperados; p95 de cancelación de hasta 50 ms; heap/RSS hasta 10 % sobre TypeScript; y mejora mínima del 15 % en p95 o CPU para la carga elegida. **Entregable:** tabla de métricas y comandos. **Depende de:** pasos 1 a 4. **Salida:** umbrales y carga representativa aprobados antes de migrar comportamiento.
6. **Núcleo Rust puro (P0).** Extraer `brass-engine-core` sin `wasm-bindgen`, `JsValue`, I/O ni permisos; conservar WASM y un futuro daemon como adaptadores finos. **Entregable:** crate portable con API mínima. **Depende de:** pasos 2 a 4. **Salida:** compila sin dependencias de host ni TypeScript.
7. **Robustez de entradas (P0).** Validar root, índices, referencias, tamaños máximos y overflow antes de reservar; sustituir `expect` expuesto por errores recuperables. **Entregable:** validadores y catálogo de errores. **Depende de:** pasos 3, 4 y 6. **Salida:** entradas inválidas devuelven errores tipados sin panic ni asignaciones fuera de límite.
8. **Pruebas nativas del núcleo (P0).** Añadir pruebas unitarias, de propiedades y fuzzing para scheduler, timer wheel, registry, slab y decodificadores. **Entregable:** suite Rust reproducible. **Depende de:** pasos 6 y 7. **Salida:** `cargo test`, Clippy y las pruebas configuradas terminan sin fallos.
9. **API WASM mínima (P1).** Exponer solo operaciones del contrato, sin permisos implícitos ni callbacks de host; incluir creación, ejecución por lote, cancelación, reinicio y liberación. **Entregable:** binding WASM versionado. **Depende de:** pasos 3, 4 y 8. **Salida:** el artefacto WASM se genera y respeta los límites del contrato.
10. **Adaptador TypeScript y fallback (P1).** Validar entradas, negociar capacidades, traducir errores y gestionar el engine; mantener TypeScript como fallback controlado. **Entregable:** adaptador con selección explícita de motor. **Depende de:** pasos 3, 4 y 9. **Salida:** una carga o incompatibilidad activa fallback y un diagnóstico sin datos sensibles.
11. **Corpus de paridad end-to-end (P1).** Ejecutar programas y semillas iguales en TypeScript, WASM y Rust: valor/error, wakeups, interrupción, finalizadores y métricas. **Entregable:** corpus compartido con fixtures minimizados. **Depende de:** pasos 4, 8, 9 y 10. **Salida:** paridad del 100 % y cada divergencia se reproduce como fixture.
12. **Ciclo de vida y recursos (P1).** Probar cancelación, timeout, reinicio, caída del engine, liberación de memoria y trabajo huérfano bajo carga. **Entregable:** pruebas de integración de ciclo de vida. **Depende de:** pasos 9 a 11. **Salida:** cancelación p95 hasta 50 ms, cero tareas huérfanas y recuperación por fallback tras reinicio.
13. **Observabilidad de frontera (P1).** Instrumentar ABI, latencia, bytes, asignaciones, fibras, colas, errores, cancelaciones y fallback; redactar prompts, paths y secretos. **Entregable:** contrato de métricas y trazas. **Depende de:** pasos 5, 9 y 10. **Salida:** una prueba genera todas las señales requeridas sin datos sensibles.
14. **Piloto sin escrituras (P1).** Aplicar el núcleo a indexación, búsqueda o planificación cancelable, sin acceso directo al workspace y con TypeScript conservando autorización y UX. **Entregable:** piloto con fallback TypeScript. **Depende de:** pasos 10 a 13. **Salida:** no realiza escrituras, las aprobaciones permanecen en TypeScript y funcionan WASM y fallback.
15. **Decisión de adopción incremental (P2).** Comparar TS, WASM y futuro servicio Rust en la misma máquina, carga y versión; documentar compatibilidad, distribución y reversión. **Entregable:** informe de promoción por capacidad. **Depende de:** pasos 5 y 11 a 14. **Salida:** solo se promueve si cumple todos los umbrales del paso 5; si no, WASM sigue opcional y fallback activo.

## Arquitectura objetivo para un fork de VS Code

### Principio

No incrustar el runtime ni Rust dentro del renderer. El renderer debe seguir siendo UI aislada; el extension host debe conservar las APIs de extensiones y el control de permisos. Las operaciones intensivas, indexación, planificación y estado de larga vida pertenecen a un proceso local nativo controlado por el producto.

```text
Renderer / Workbench (TypeScript)
  └─ comandos, chat, diff, progreso, permisos visibles
          │ APIs internas controladas
Extension Host (TypeScript)
  └─ AgentHost, workspace trust, secrets, diagnósticos, lifecycle
          │ IPC local autenticado y versionado
Brass Service (proceso Rust nativo por perfil/ventana)
  └─ scheduler, índice, búsqueda, plan declarativo, cache, telemetría agregada
          │ adaptadores explícitos, cancelables
OS / filesystem / red / modelo local-remoto
```

### Límites obligatorios

| Límite | Responsabilidad | Regla |
|---|---|---|
| Renderer | UI y estado visual | Nunca ejecuta shell, FS ni modelo directamente. |
| Extension host | Capacidades VS Code y autorización | Verifica workspace trust, aprobación y URI antes de cada efecto. |
| Servicio Rust | Datos, scheduling e indexación | No recibe token de proveedor ni permiso implícito para escribir. |
| Adaptadores host | FS, shell, red y LLM | Toda llamada lleva cancelación, deadline, correlación y política. |
| Persistencia | Cache, índices e historial | Datos por workspace/perfil, migraciones versionadas, redacción y cuotas. |

### Protocolo y ciclo de vida

- Usar un socket local nombrado/pipe o stdio privado, con handshake: versión de protocolo, build, capacidades, nonce de sesión y límites de mensaje. JSON-RPC es adecuado para el piloto; migrar mensajes de alto volumen a un framing binario versionado solo tras medirlo.
- Todo request lleva `requestId`, `sessionId`, `workspaceId`, deadline, prioridad y `CancellationToken` propagado a `Async`/fiber y a Rust. `cancel` debe ser idempotente y confirmarse con un evento terminal.
- El extension host es dueño del proceso: inicio perezoso, health check, reinicio con backoff, apagado ordenado al cerrar ventana y rehidratación desde persistencia validada.
- Para una operación de escritura: UI solicita → extension host decide/aprueba → servicio propone patch declarativo → extension host revalida paths, hash/base y policy → UI previsualiza → host aplica. Rust no escribe el workspace directamente en la primera fase.
- Los eventos de progreso se transmiten como stream acotado; al saturarse se coalescen estados (progreso/diagnóstico) y se preservan terminales, no se acumulan infinitamente.

### Qué construir primero

**Piloto de 6–8 semanas:** servicio Rust que indexe workspace y ejecute búsqueda/ranking cancelables, sin escrituras ni secretos; extensión conserva el CLI como fallback. Medir tiempo de arranque, memoria residente, reindexación incremental, cancelación, CPU en idle y UX de progreso.

**Segunda fase:** scheduler de tareas de agent y caché de contexto en el servicio, con protocolo de acciones declarativas. Las acciones de host continúan ejecutándose en TypeScript bajo `AgentHost`.

**Tercera fase:** evaluar compartir el núcleo de scheduler/colas entre WASM y servicio nativo mediante crate core sin bindings. No forzar esta unificación si empeora la simplicidad o no aporta rendimiento.

## Backlog priorizado

| Prioridad | Iniciativa | Impacto | Coste/riesgo | Criterio de salida |
|---|---|---:|---|---|
| P0 | Especificación y versionado ABI WASM | Alto | Bajo/medio | Bridge y crate negocian versión y rechazan inputs inválidos. |
| P0 | Corpus de paridad TS/WASM real | Alto | Medio | Semántica de lifecycle crítica coincide en CI con WASM real. |
| P0 | `AgentHost` y contrato de acciones | Alto | Medio | Agent core se ejecuta con adapters Node y VS Code sin importar `vscode`. |
| P0 | Baselines de heap/latencia/cancelación | Alto | Bajo | Presupuestos reproducibles y artefactos comparables. |
| P1 | Modularizar crate y fijar toolchain/CI Rust | Alto | Medio | `cargo fmt`, Clippy, tests y WASM build deterministas. |
| P1 | Protocolo IPC y servicio Rust de indexación | Alto | Medio | Piloto cancelable, aislado, sin escrituras y con fallback CLI. |
| P1 | Diagnóstico unificado y redacción frontera | Medio | Medio | Eventos correlacionables sin prompts, secretos ni paths sensibles. |
| P1 | Perfiles HTTP y contrato de middleware | Medio | Bajo | Tres perfiles y composición documentada/probada. |
| P2 | Promover WASM si supera métricas | Medio | Medio | Paridad + mejora definida, sin degradación de DX. |
| P2 | Servicio Rust para scheduling del agent | Medio | Alto | No altera permisos ni empeora recuperación/cancelación. |
| P3 | Transporte binario IPC de alto volumen | Bajo/medio | Alto | Solo si profiling muestra JSON-RPC como cuello de botella. |

## Riesgos y mitigaciones

- **Duplicar scheduler en TS, WASM y Rust nativo.** Mitigar con semántica y corpus comunes antes de compartir código; no con una abstracción prematura.
- **Crossings WASM/JS eliminan el beneficio.** Registrar tamaño/frecuencia de batches y mantener el host callback del lado TypeScript.
- **Un daemon amplía superficie de seguridad.** Aplicar mínimo privilegio, workspace trust, permisos por operación, autenticación local de sesión y límites de recursos.
- **Estados persistidos incompatibles o sensibles.** Usar esquema versionado, migraciones, cuotas, borrado explícito y redacción antes de persistir.
- **Regresión de UX por proceso adicional.** Inicio perezoso, fallback CLI, health check y métricas de tiempo hasta primer resultado.
- **Deuda de API pública.** Etiquetar madurez, preferir subpaths y publicar migraciones antes de retirar compatibilidad.

## Validación sugerida

Para cambios normales: `npm run test:types` y `npm test`. Para core/engine: pruebas focalizadas de `src/core/runtime/__tests__/engine` y scheduler, más build WASM real. Para empaquetado: `npm run build` y `npm run validate:cjs`. Para Rust, añadir y ejecutar `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` y un test de integración contra el artefacto wasm generado. Para el fork, usar pruebas de integración que simulen cancelación, caída/reinicio del servicio, workspace no confiable, patch inválido y saturación de eventos.

Antes de aprobar una migración nativa, comparar TS/WASM/servicio Rust en la misma máquina, carga y versión: p50/p95/p99, CPU, RSS, heap JS, crossings, latencia de cancelación y tasa de errores. Una mejora sin estos datos no justifica sumar una frontera operativa.

## Conclusión

La base del proyecto es viable para crecer hacia un fork de VS Code, sobre todo porque ya prioriza lazy effects, cancelación, scopes, políticas y observabilidad. La siguiente inversión debe ser disciplina de contratos y medición. Rust/WASM debe convertirse en un núcleo pequeño, probado y reusable para coordinación y datos; TypeScript debe seguir llevando integración de host, UX y autorización. Esa separación permite ganar rendimiento y robustez sin sacrificar la ergonomía que hace valioso al runtime.
