import type { RuntimeEvent } from "./events";

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
    finalizers: Array<{ id: number; label?: string; status: "added"|"running"|"done" }>;
};

export class RuntimeRegistry {
    fibers = new Map<number, FiberInfo>();
    scopes = new Map<number, ScopeInfo>();

    private recent: RuntimeEvent[] = [];
    private recentCap = 2000;

    onEvent = (ev: RuntimeEvent) => {
        // ring buffer de eventos recientes (para dumps explicables)
        this.recent.push(ev);
        if (this.recent.length > this.recentCap) this.recent.shift();

        switch (ev.type) {
            case "fiber.start": {
                const id = ev.fiberId!;
                this.fibers.set(id, {
                    fiberId: id,
                    parentFiberId: ev.parentFiberId,
                    name: (ev.data?.name as any) ?? undefined,
                    runState: "Running",
                    status: "Running",
                    createdAt: ev.wallTs,
                    lastActiveAt: ev.wallTs,
                    scopeId: ev.scopeId,
                    traceId: ev.traceId,
                    spanId: ev.spanId,
                });
                break;
            }
            case "fiber.suspend": {
                const f = this.fibers.get(ev.fiberId!);
                if (f) {
                    f.runState = "Suspended";
                    f.lastActiveAt = ev.wallTs;
                    f.awaiting = { reason: String(ev.data?.reason ?? "unknown"), detail: ev.data?.detail as any };
                }
                break;
            }
            case "fiber.resume": {
                const f = this.fibers.get(ev.fiberId!);
                if (f) {
                    f.runState = "Running";
                    f.lastActiveAt = ev.wallTs;
                    f.awaiting = undefined;
                }
                break;
            }
            case "fiber.end": {
                const f = this.fibers.get(ev.fiberId!);
                if (f) {
                    f.runState = "Done";
                    f.lastActiveAt = ev.wallTs;
                    f.status = (ev.data?.status as any) ?? "Done";
                    f.lastEnd = { status: String(ev.data?.status ?? "done"), error: ev.data?.error as any };
                }
                break;
            }

            case "scope.open": {
                const sid = ev.scopeId!;
                this.scopes.set(sid, {
                    scopeId: sid,
                    parentScopeId: ev.data?.parentScopeId as any,
                    ownerFiberId: ev.fiberId,
                    openAt: ev.wallTs,
                    finalizers: [],
                });
                break;
            }
            case "scope.close": {
                const s = this.scopes.get(ev.scopeId!);
                if (s) s.closedAt = ev.wallTs;
                break;
            }
            case "finalizer.add": {
                const s = this.scopes.get(ev.scopeId!);
                if (s) s.finalizers.push({ id: Number(ev.data?.finalizerId), label: ev.data?.label as any, status: "added" });
                break;
            }
            case "finalizer.run": {
                const s = this.scopes.get(ev.scopeId!);
                if (s) {
                    const id = Number(ev.data?.finalizerId);
                    const fz = s.finalizers.find(x => x.id === id);
                    if (fz) fz.status = "running";
                }
                break;
            }
            case "finalizer.done": {
                const s = this.scopes.get(ev.scopeId!);
                if (s) {
                    const id = Number(ev.data?.finalizerId);
                    const fz = s.finalizers.find(x => x.id === id);
                    if (fz) fz.status = "done";
                }
                break;
            }
        }
    };

    getRecentEvents() { return this.recent.slice(); }
}
