import { emptyContext, type FiberContext, type TraceContext } from "./contex";
import type { RuntimeHooks } from "./events";
import type { RuntimeFiber } from "./fiber";
import { BrassEnv, Tracer } from "./tracer";

type ForkServices = {
    tracer: Tracer;
    seed?: TraceContext;
    baggage?: TraceContext["baggage"];
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
                {
                    fiberId: fiber.id,
                    scopeId: fiber.scopeId,
                    traceId: trace?.traceId,
                    spanId: trace?.spanId,
                    parentSpanId: trace?.parentSpanId,
                    traceState: trace?.traceState,
                    baggage: trace?.baggage,
                    sampled: trace?.sampled,
                }
            );
        },
    };
}

function resolveForkServices(env?: BrassEnv): ForkServices {
    const defaultTracer: Tracer = {
        newTraceId: () => randomRuntimeId("trace"),
        newSpanId: () => randomRuntimeId("span"),
    };

    const brass = env?.brass;

    const tracer = brass?.tracer ?? defaultTracer;
    const seed = brass?.traceSeed;
    const baggage = brass?.baggage;

    const childName = brass?.childName ?? ((p?: string) => (p ? `${p}/child` : undefined));

    return { tracer, seed, baggage, childName };
}

function randomRuntimeId(prefix: string): string {
    const cryptoLike = (globalThis as any).crypto;

    if (typeof cryptoLike?.randomUUID === "function") {
        return cryptoLike.randomUUID();
    }

    // Runtime trace/span ids are observability metadata, not secrets.
    // This fallback keeps Node versions without global WebCrypto working.
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function forkTrace(svc: ForkServices, parentTrace: TraceContext | null): TraceContext | null {
    if (parentTrace) {
        return {
            traceId: parentTrace.traceId,
            spanId: svc.tracer.newSpanId(),
            parentSpanId: parentTrace.spanId,
            sampled: parentTrace.sampled,
            traceState: parentTrace.traceState,
            baggage: parentTrace.baggage,
        };
    }
    if (svc.seed) {
        const baggage = svc.seed.baggage ?? svc.baggage;
        return baggage ? { ...svc.seed, baggage } : { ...svc.seed };
    }
    const baggage = svc.baggage;
    return {
        traceId: svc.tracer.newTraceId(),
        spanId: svc.tracer.newSpanId(),
        sampled: true,
        ...(baggage ? { baggage } : {}),
    };
}
