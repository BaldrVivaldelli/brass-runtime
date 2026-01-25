import type { RuntimeEvent } from "./events";

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

export class InMemoryTracer {
    spans = new Map<string, SpanRec>(); // key spanId

    onEvent = (ev: RuntimeEvent) => {
        // regla simple: span por scope
        if (ev.type === "scope.open") {
            const traceId = ev.traceId ?? "no-trace";
            const spanId = ev.spanId ?? `scope-${ev.scopeId}`;
            this.spans.set(spanId, {
                traceId, spanId,
                parentSpanId: ev.data?.parentSpanId as any,
                name: String(ev.data?.name ?? `scope#${ev.scopeId}`),
                startWallTs: ev.wallTs,
                attrs: (ev.data?.attrs as any) ?? {},
                events: [],
            });
        }

        if (ev.type === "scope.close") {
            const spanId = ev.spanId ?? `scope-${ev.scopeId}`;
            const sp = this.spans.get(spanId);
            if (sp) sp.endWallTs = ev.wallTs;
        }

        // opcional: meter eventos de runtime en el span actual
        if (ev.type === "fiber.suspend" || ev.type === "fiber.end") {
            const spanId = ev.spanId;
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (!sp) return;
            sp.events.push({ wallTs: ev.wallTs, name: ev.type, attrs: ev.data });
        }
    };

    exportFinished() {
        // export simple: todos los spans con endWallTs
        return Array.from(this.spans.values()).filter(s => s.endWallTs != null);
    }
}
