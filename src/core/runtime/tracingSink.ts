import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "./events";

type SpanRec = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startWallTs: number;
    endWallTs?: number;
    attrs: Record<string, any>;
    events: Array<{ wallTs: number; name: string; attrs?: any }>;
};


export class InMemoryTracer implements RuntimeHooks {
    spans = new Map<string, SpanRec>(); // key: spanId

    emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
        const wallTs = Date.now();

        const traceId = ctx.traceId ?? "no-trace";
        const spanId = ctx.spanId; // idealmente siempre existe si tracing está activado

        if (ev.type === "fiber.start") {
            if (!spanId) return; // si no tenés spanId, no podés trazar bien
            this.spans.set(spanId, {
                traceId,
                spanId,
                // parentSpanId: ctx.parentSpanId (si algún día lo agregás)
                name: ev.name ?? `fiber#${ev.fiberId}`,
                startWallTs: wallTs,
                attrs: { fiberId: ev.fiberId, parentFiberId: ev.parentFiberId, scopeId: ev.scopeId },
                events: [],
            });
            return;
        }

        if (ev.type === "fiber.end") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (sp) {
                sp.endWallTs = wallTs;
                sp.events.push({ wallTs, name: "fiber.end", attrs: { status: ev.status, error: ev.error } });
            }
            return;
        }

        // eventos que querés anexar al span actual
        if (ev.type === "fiber.suspend" || ev.type === "fiber.resume" || ev.type === "scope.open" || ev.type === "scope.close") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (!sp) return;
            sp.events.push({ wallTs, name: ev.type, attrs: ev });
        }
    }

    exportFinished() {
        return Array.from(this.spans.values()).filter(s => s.endWallTs != null);
    }
}
