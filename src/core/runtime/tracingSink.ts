import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks, RuntimeSpanLink } from "./events";
import { Cause } from "../types/effect";

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
    private readonly finishedSpanIds: string[] = [];
    private readonly finishedSpanSet = new Set<string>();
    private finishedSpanOffset = 0;
    private finishedSpanCount = 0;
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
                const wasOpen = sp.endWallTs == null;
                sp.endWallTs = wallTs;
                sp.events.push({ wallTs, name: "fiber.end", attrs: this.attrs({ status: ev.status, error: this.error(ev.error) }) });
                if (wasOpen) this.markFinished(spanId);
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
                const wasOpen = sp.endWallTs == null;
                sp.endWallTs = wallTs;
                sp.events.push({ wallTs, name: "span.end", attrs: this.attrs({ status: ev.status, error: this.error(ev.error), ...(ev.attributes ?? {}) }) });
                if (wasOpen) this.markFinished(spanId);
                this.pruneFinished();
            }
            return;
        }

        // eventos que querés anexar al span actual
        if (ev.type === "fiber.suspend" || ev.type === "fiber.resume" || ev.type === "scope.open" || ev.type === "scope.close" || ev.type === "schedule.decision") {
            if (!spanId) return;
            const sp = this.spans.get(spanId);
            if (!sp) return;
            sp.events.push({ wallTs, name: ev.type, attrs: this.attrs(ev as any) });
        }
    }

    exportFinished(): RuntimeSpan[] {
        this.pruneFinished();
        const out: RuntimeSpan[] = [];
        for (let i = this.finishedSpanOffset; i < this.finishedSpanIds.length; i++) {
            const spanId = this.finishedSpanIds[i]!;
            if (!this.finishedSpanSet.has(spanId)) continue;
            const span = this.spans.get(spanId);
            if (span?.endWallTs != null) out.push(span);
        }
        return out;
    }

    pruneFinished(spanIds?: Iterable<string>): number {
        let dropped = 0;

        if (spanIds) {
            for (const spanId of spanIds) {
                if (this.deleteFinished(spanId)) dropped++;
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
            finishedSpans: this.finishedSpanCount,
            prunedFinishedSpans: this.prunedFinishedSpans,
        };
    }

    private attrs(attrs: Record<string, unknown>): Record<string, unknown> {
        return this.options.sanitizeAttributes?.(attrs) ?? attrs;
    }

    private error(error: unknown): unknown {
        const normalized = Cause.isCause(error) ? Cause.pretty(error, { singleLine: true }) : error;
        return normalized === undefined ? undefined : this.options.sanitizeError?.(normalized) ?? normalized;
    }

    private now(): number {
        return this.options.clock?.() ?? Date.now();
    }

    private pruneExpiredFinished(): number {
        const maxAgeMs = this.options.maxSpanAgeMs;
        if (maxAgeMs === undefined || maxAgeMs <= 0) return 0;

        const now = this.now();
        let dropped = 0;
        while (true) {
            const oldest = this.peekOldestFinished();
            if (!oldest) break;
            if (now - (oldest.span.endWallTs ?? now) <= maxAgeMs) break;
            if (this.deleteOldestFinished()) dropped++;
        }
        return dropped;
    }

    private pruneFinishedOverLimit(): number {
        const maxFinishedSpans = this.options.maxFinishedSpans;
        if (maxFinishedSpans === undefined || maxFinishedSpans < 0) return 0;

        let dropped = 0;
        while (this.finishedSpanCount > maxFinishedSpans) {
            if (this.deleteOldestFinished()) dropped++;
            else break;
        }
        return dropped;
    }

    private markFinished(spanId: string): void {
        if (this.finishedSpanSet.has(spanId)) return;
        this.finishedSpanSet.add(spanId);
        this.finishedSpanIds.push(spanId);
        this.finishedSpanCount++;
        this.compactFinishedIds();
    }

    private deleteFinished(spanId: string): boolean {
        const span = this.spans.get(spanId);
        if (span?.endWallTs == null) return false;
        const deleted = this.spans.delete(spanId);
        if (this.finishedSpanSet.delete(spanId)) {
            this.finishedSpanCount = Math.max(0, this.finishedSpanCount - 1);
        }
        return deleted;
    }

    private peekOldestFinished(): { spanId: string; span: RuntimeSpan } | undefined {
        while (this.finishedSpanOffset < this.finishedSpanIds.length) {
            const spanId = this.finishedSpanIds[this.finishedSpanOffset]!;
            if (!this.finishedSpanSet.has(spanId)) {
                this.finishedSpanOffset++;
                continue;
            }
            const span = this.spans.get(spanId);
            if (!span || span.endWallTs == null) {
                this.finishedSpanSet.delete(spanId);
                this.finishedSpanCount = Math.max(0, this.finishedSpanCount - 1);
                this.finishedSpanOffset++;
                continue;
            }
            return { spanId, span };
        }
        this.compactFinishedIds();
        return undefined;
    }

    private deleteOldestFinished(): boolean {
        const oldest = this.peekOldestFinished();
        if (!oldest) return false;
        this.finishedSpanOffset++;
        return this.deleteFinished(oldest.spanId);
    }

    private compactFinishedIds(): void {
        if (this.finishedSpanOffset < 1024 || this.finishedSpanOffset * 2 < this.finishedSpanIds.length) return;
        this.finishedSpanIds.splice(0, this.finishedSpanOffset);
        this.finishedSpanOffset = 0;
    }
}
