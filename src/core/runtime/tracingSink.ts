import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks, RuntimeSpanLink } from "./events";

export type RuntimeSpanEvent = {
    wallTs: number;
    name: string;
    attrs?: unknown;
};

export type RuntimeSpan = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceState?: string;
    name: string;
    startWallTs: number;
    endWallTs?: number;
    attrs: Record<string, unknown>;
    links: RuntimeSpanLink[];
    events: RuntimeSpanEvent[];
};

export type InMemoryTracerOptions = {
    readonly sanitizeAttributes?: (attrs: Record<string, unknown>) => Record<string, unknown>;
    readonly sanitizeError?: (error: unknown) => unknown;
    readonly maxFinishedSpans?: number;
    readonly maxSpanAgeMs?: number;
    readonly clock?: () => number;
};

export type InMemoryTracerStats = {
    readonly storedSpans: number;
    readonly finishedSpans: number;
    readonly prunedFinishedSpans: number;
};

export class InMemoryTracer implements RuntimeHooks {
    spans = new Map<string, RuntimeSpan>(); // key: spanId
    private prunedFinishedSpans = 0;

    constructor(private readonly options: InMemoryTracerOptions = {}) {}

    emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
        if (ctx.sampled === false) return;

        const wallTs = this.now();

        const traceId = ctx.traceId ?? "no-trace";
        const spanId = ctx.spanId; // idealmente siempre existe si tracing está activado

        if (ev.type === "fiber.start") {
            if (!spanId) return; // si no tenés spanId, no podés trazar bien
            this.spans.set(spanId, {
                traceId,
                spanId,
                parentSpanId: ctx.parentSpanId,
                traceState: ctx.traceState,
                name: ev.name ?? `fiber#${ev.fiberId}`,
                startWallTs: wallTs,
                attrs: this.attrs({ fiberId: ev.fiberId, parentFiberId: ev.parentFiberId, scopeId: ev.scopeId }),
                links: [],
                events: [],
            });
            return;
        }

        if (ev.type === "fiber.end") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (sp) {
                sp.endWallTs = wallTs;
                sp.events.push({ wallTs, name: "fiber.end", attrs: this.attrs({ status: ev.status, error: this.error(ev.error) }) });
                this.pruneFinished();
            }
            return;
        }

        if (ev.type === "span.start") {
            if (!spanId) return;
            this.spans.set(spanId, {
                traceId,
                spanId,
                parentSpanId: ctx.parentSpanId,
                traceState: ctx.traceState,
                name: ev.name,
                startWallTs: wallTs,
                attrs: this.attrs(ev.attributes ?? {}),
                links: ev.links ?? [],
                events: [],
            });
            return;
        }

        if (ev.type === "span.event") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (!sp) return;
            sp.events.push({ wallTs, name: ev.name, attrs: this.attrs(ev.attributes ?? {}) });
            return;
        }

        if (ev.type === "span.end") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (sp) {
                sp.endWallTs = wallTs;
                sp.events.push({ wallTs, name: "span.end", attrs: this.attrs({ status: ev.status, error: this.error(ev.error), ...(ev.attributes ?? {}) }) });
                this.pruneFinished();
            }
            return;
        }

        // eventos que querés anexar al span actual
        if (ev.type === "fiber.suspend" || ev.type === "fiber.resume" || ev.type === "scope.open" || ev.type === "scope.close") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (!sp) return;
            sp.events.push({ wallTs, name: ev.type, attrs: this.attrs(ev as any) });
        }
    }

    exportFinished(): RuntimeSpan[] {
        this.pruneFinished();
        return Array.from(this.spans.values()).filter(s => s.endWallTs != null);
    }

    pruneFinished(spanIds?: Iterable<string>): number {
        let dropped = 0;

        if (spanIds) {
            for (const spanId of spanIds) {
                const span = this.spans.get(spanId);
                if (span?.endWallTs == null) continue;
                if (this.spans.delete(spanId)) dropped++;
            }
            this.prunedFinishedSpans += dropped;
            return dropped;
        }

        dropped += this.pruneExpiredFinished();
        dropped += this.pruneFinishedOverLimit();
        this.prunedFinishedSpans += dropped;
        return dropped;
    }

    stats(): InMemoryTracerStats {
        return {
            storedSpans: this.spans.size,
            finishedSpans: Array.from(this.spans.values()).filter(s => s.endWallTs != null).length,
            prunedFinishedSpans: this.prunedFinishedSpans,
        };
    }

    private attrs(attrs: Record<string, unknown>): Record<string, unknown> {
        return this.options.sanitizeAttributes?.(attrs) ?? attrs;
    }

    private error(error: unknown): unknown {
        return error === undefined ? undefined : this.options.sanitizeError?.(error) ?? error;
    }

    private now(): number {
        return this.options.clock?.() ?? Date.now();
    }

    private pruneExpiredFinished(): number {
        const maxAgeMs = this.options.maxSpanAgeMs;
        if (maxAgeMs === undefined || maxAgeMs <= 0) return 0;

        const now = this.now();
        let dropped = 0;
        for (const [spanId, span] of this.spans) {
            if (span.endWallTs == null) continue;
            if (now - span.endWallTs > maxAgeMs && this.spans.delete(spanId)) dropped++;
        }
        return dropped;
    }

    private pruneFinishedOverLimit(): number {
        const maxFinishedSpans = this.options.maxFinishedSpans;
        if (maxFinishedSpans === undefined || maxFinishedSpans < 0) return 0;

        const finished = Array.from(this.spans.values())
            .filter((span) => span.endWallTs != null)
            .sort((a, b) => (a.endWallTs ?? 0) - (b.endWallTs ?? 0));
        const overflow = finished.length - maxFinishedSpans;
        if (overflow <= 0) return 0;

        let dropped = 0;
        for (let i = 0; i < overflow; i++) {
            const span = finished[i]!;
            if (this.spans.delete(span.spanId)) dropped++;
        }
        return dropped;
    }
}
