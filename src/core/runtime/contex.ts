export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

export type ContextNode = {
    parent: ContextNode | null;
    patch: Record<string, JSONValue>;
};

export const emptyContext: ContextNode = { parent: null, patch: Object.create(null) };

export function ctxExtend(parent: ContextNode, patch: Record<string, JSONValue>): ContextNode {
    return { parent, patch };
}

export function ctxToObject(ctx: ContextNode): Record<string, JSONValue> {
    // materializa solo cuando hace falta (p.ej. al loggear)
    const out: Record<string, JSONValue> = Object.create(null);
    const seen = new Set<string>();
    let cur: ContextNode | null = ctx;
    while (cur) {
        for (const k of Object.keys(cur.patch)) {
            if (!seen.has(k)) {
                out[k] = cur.patch[k];
                seen.add(k);
            }
        }
        cur = cur.parent;
    }
    return out;
}

export type TraceContext = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    sampled?: boolean;
};

export type FiberContext = {
    log: ContextNode;
    trace: TraceContext | null;
};
