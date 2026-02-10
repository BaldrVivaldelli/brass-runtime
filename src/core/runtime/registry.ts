import type { RuntimeEmitContext, RuntimeEvent, RuntimeEventRecord, RuntimeHooks } from "./events";

export type FiberRunState = "Queued" | "Running" | "Suspended" | "Done";

export type FiberInfo = {
    fiberId: number;
    parentFiberId?: number;
    name?: string;

    runState: FiberRunState;
    status: "Running" | "Done" | "Interrupted";

    createdAt: number;
    lastActiveAt: number;

    scopeId?: number;
    traceId?: string;
    spanId?: string;

    awaiting?: { reason: string; detail?: string };
    lastEnd?: { status: string; error?: string };
};

export type ScopeInfo = {
    scopeId: number;
    parentScopeId?: number;
    ownerFiberId?: number;
    openAt: number;
    closedAt?: number;
    finalizers: Array<{ id: number; label?: string; status: "added" | "running" | "done" }>;
};

export class RuntimeRegistry implements RuntimeHooks {
    fibers = new Map<number, FiberInfo>();
    scopes = new Map<number, ScopeInfo>();

    private seq = 1;
    private recent: RuntimeEventRecord[] = [];
    private recentCap = 2000;

    emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
        const rec: RuntimeEventRecord = {
            ...ev,
            ...ctx,
            seq: this.seq++,
            wallTs: Date.now(),
            ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
        };

        this.recent.push(rec);

        if (this.recent.length > this.recentCap) this.recent.shift();

        switch (rec.type) {
            case "fiber.start": {
                const id = rec.fiberId;
                this.fibers.set(id, {
                    fiberId: id,
                    parentFiberId: rec.parentFiberId,
                    name: rec.name,
                    runState: "Running",
                    status: "Running",
                    createdAt: rec.wallTs,
                    lastActiveAt: rec.wallTs,
                    scopeId: rec.scopeId,
                    traceId: rec.traceId,
                    spanId: rec.spanId,
                });
                break;
            }

            case "fiber.suspend": {
                const f = this.fibers.get(rec.fiberId);
                if (f) {
                    f.runState = "Suspended";
                    f.lastActiveAt = rec.wallTs;
                    f.awaiting = { reason: rec.reason ?? "unknown" };
                }
                break;
            }

            case "fiber.resume": {
                const f = this.fibers.get(rec.fiberId);
                if (f) {
                    f.runState = "Running";
                    f.lastActiveAt = rec.wallTs;
                    f.awaiting = undefined;
                }
                break;
            }

            case "fiber.end": {
                const f = this.fibers.get(rec.fiberId);
                if (f) {
                    f.runState = "Done";
                    f.lastActiveAt = rec.wallTs;
                    f.status = rec.status === "interrupted" ? "Interrupted" : "Done";
                    f.lastEnd = { status: rec.status, error: rec.error as any };
                }
                break;
            }

            case "scope.open": {
                const sid = rec.scopeId;
                this.scopes.set(sid, {
                    scopeId: sid,
                    parentScopeId: rec.parentScopeId,
                    ownerFiberId: rec.fiberId,
                    openAt: rec.wallTs,
                    finalizers: [],
                });
                break;
            }

            case "scope.close": {
                const s = this.scopes.get(rec.scopeId);
                if (s) s.closedAt = rec.wallTs;
                break;
            }
        }
    }

    getRecentEvents() { return this.recent.slice(); }
}
