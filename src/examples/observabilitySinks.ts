// examples/observabilitySinks.ts

import { Runtime } from "../core/runtime/runtime";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "../core/runtime/events";
import { async, asyncFlatMap, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import { withScopeAsync } from "../core/runtime/scope";

// This example targets Node; keep types lightweight for library compilation.
declare const process: any;

// ---------------------
// Logger sink (JSON) + ctx
// ---------------------
function makeLoggerSink() {
    return (ev: RuntimeEvent, ctx: RuntimeEmitContext) => {
        if (ev.type !== "log") return;

        const line = {
            ts: Date.now(),
            type: ev.type,
            level: ev.level,
            message: ev.message,
            fields: ev.fields ?? {},

            // ctx (correlación)
            fiberId: ctx.fiberId,
            scopeId: ctx.scopeId,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
        };

        // JSON limpio, fácil de ingerir en Loki/ELK/etc.
        const out = JSON.stringify(line);
        if (ev.level === "error") console.error(out);
        else console.log(out);
    };
}

// ---------------------
// Tracing sink (minimal)
// - convierte fiber.start/end en "spans" con duración
// ---------------------
function makeTracingSink() {
    const startByFiber = new Map<number, { ts: number; name?: string; scopeId?: number }>();

    return (ev: RuntimeEvent, ctx: RuntimeEmitContext) => {
        if (ev.type === "fiber.start") {
            startByFiber.set(ev.fiberId, {
                ts: Date.now(),
                name: ev.name,
                scopeId: ev.scopeId,
            });
            return;
        }

        if (ev.type === "fiber.end") {
            const st = startByFiber.get(ev.fiberId);
            if (!st) return;

            const durMs = Date.now() - st.ts;

            const span = {
                ts: Date.now(),
                kind: "span",
                name: st.name ?? `fiber#${ev.fiberId}`,
                fiberId: ev.fiberId,
                scopeId: st.scopeId ?? ctx.scopeId,
                status: ev.status,
                durationMs: durMs,

                // futuro: traceId/spanId cuando metas FiberRef Context
                traceId: ctx.traceId,
                spanId: ctx.spanId,
            };

            console.log(JSON.stringify(span));
            startByFiber.delete(ev.fiberId);
        }
    };
}

// ---------------------
// Hooks = fanout a sinks
// ---------------------
function makeHooks(...sinks: Array<(ev: RuntimeEvent, ctx: RuntimeEmitContext) => void>): RuntimeHooks {
    return {
        emit(ev, ctx) {
            for (const s of sinks) {
                try {
                    s(ev, ctx);
                } catch (e) {
                    // no queremos que un sink rompa el runtime
                    console.error("[sink] threw", e);
                }
            }
        },
    };
}

// ---------------------
// helpers effect
// ---------------------
function sleep(ms: number): Async<unknown, never, void> {
    return async((_env, cb) => {
        const t = setTimeout(() => cb({ _tag: "Success", value: undefined }), ms);
        return () => clearTimeout(t);
    });
}

// log como effect (captura runtime en closure para no depender de getCurrentRuntime)
function logInfo<R>(rt: Runtime<R>, message: string, fields?: Record<string, unknown>): Async<R, never, void> {
    return asyncSync(() => rt.log("info", message, fields)) as any;
}

function task<R>(rt: Runtime<R>, name: string, ms: number): Async<R, never, string> {
    return asyncFlatMap(logInfo(rt, "task.start", { name, ms }), () =>
        asyncFlatMap(sleep(ms), () =>
            asyncFlatMap(logInfo(rt, "task.done", { name, ms }), () => asyncSucceed(`ok:${name}`))
        )
    ) as any;
}

// ---------------------
// main
// ---------------------
async function main() {
    type Env = {};
    const env: Env = {};

    // instalar hooks (logger + tracing)
    const hooks = makeHooks(makeLoggerSink(), makeTracingSink());

    const rt = new Runtime<Env>({ env, hooks });

    // programa: scope + zip paralelo (si lo querés, acá solo demo de forks)
    const program = withScopeAsync(rt, (scope) =>
        asyncSync(() => {
            // fork 3 fibers en el scope (si fiber.ts emite fiber.start/end, tracing sink imprime spans)
            scope.fork(task(rt, "A", 200) as any);
            scope.fork(task(rt, "B", 350) as any);
            scope.fork(task(rt, "C", 120) as any);

            // cancelar el scope antes de que terminen todos (para ver interrupciones)
            setTimeout(() => {
                rt.emit({ type: "log", level: "warn", message: "scope.close()", fields: { reason: "demo-timeout" } });
                scope.close();
            }, 260);
        }) as any
    );

    await rt.toPromise(program);
    rt.emit({ type: "log", level: "info", message: "example.done" });
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
