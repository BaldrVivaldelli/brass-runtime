import { emptyContext, type FiberContext, type TraceContext } from "./contex";
import type { RuntimeHooks } from "./events";
import type { RuntimeFiber } from "./fiber";
import { BrassEnv, Tracer } from "./tracer";

type ForkServices = {
    tracer: Tracer;
    seed?: TraceContext;
    childName: (parentName?: string) => string | undefined;
};

export function makeForkPolicy<R>(env: R, hooks: RuntimeHooks) {
    const svc = resolveForkServices(env as any);

    return {
        initChild(
            fiber: RuntimeFiber<any, any, any> & any,
            parent?: (RuntimeFiber<any, any, any> & any) | null,
            scopeId?: number
        ) {
            const parentCtx: FiberContext | undefined = parent?.fiberContext;

            // 1) context (log + trace)
            const trace = forkTrace(svc, parentCtx?.trace ?? null);
            fiber.fiberContext = {
                log: parentCtx?.log ?? emptyContext,
                trace,
            };

            // 2) meta “ligera” en el fiber (si querés)
            fiber.parentFiberId = parent?.id;
            fiber.name = svc.childName(parent?.name);

            // ✅ asociar fiber al scope (si se provee)
            if (scopeId !== undefined) fiber.scopeId = scopeId;

            // 3) evento start (si estás usando events.ts)
            hooks.emit(
                {
                    type: "fiber.start",
                    fiberId: fiber.id,
                    parentFiberId: parent?.id,
                    scopeId: fiber.scopeId, // ✅ ahora viaja
                    name: fiber.name,
                },
                { fiberId: parent?.id, traceId: parentCtx?.trace?.traceId, spanId: parentCtx?.trace?.spanId }
            );
        },
    };
}

function resolveForkServices(env?: BrassEnv): ForkServices {
    const defaultTracer: Tracer = {
        newTraceId: () => crypto.randomUUID(),
        newSpanId: () => crypto.randomUUID(),
    };

    const brass = env?.brass;

    const tracer = brass?.tracer ?? defaultTracer;
    const seed = brass?.traceSeed;

    const childName = brass?.childName ?? ((p?: string) => (p ? `${p}/child` : undefined));

    return { tracer, seed, childName };
}

function forkTrace(svc: ForkServices, parentTrace: TraceContext | null): TraceContext | null {
    if (parentTrace) {
        return {
            traceId: parentTrace.traceId,
            spanId: svc.tracer.newSpanId(),
            parentSpanId: parentTrace.spanId,
            sampled: parentTrace.sampled,
        };
    }
    if (svc.seed) return { ...svc.seed };
    return { traceId: svc.tracer.newTraceId(), spanId: svc.tracer.newSpanId(), sampled: true };
}
