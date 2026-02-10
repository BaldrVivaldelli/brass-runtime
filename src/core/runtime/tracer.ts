export interface Tracer {
    newTraceId(): string;
    newSpanId(): string;
}

// default (Node 18+: crypto.randomUUID)
export const defaultTracer: Tracer = {
    newTraceId: () => crypto.randomUUID(),
    newSpanId: () => crypto.randomUUID(),
};

export type BrassEnv = {
    brass?: {
        tracer?: Tracer;
        traceSeed?: { traceId: string; spanId: string; sampled?: boolean };
        childName?: (parentName?: string) => string | undefined;
    };
};
