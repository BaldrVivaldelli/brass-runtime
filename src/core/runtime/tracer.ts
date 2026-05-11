import { Baggage, TraceContext } from "./contex";
import type { RuntimeClock } from "./clock";

export type TraceSamplingInput = {
    readonly traceId: string;
    readonly spanName?: string;
    readonly parentSampled?: boolean;
    readonly attributes?: Record<string, unknown>;
};

export type TraceSampler =
    | ((input: TraceSamplingInput) => boolean)
    | {
        shouldSample(input: TraceSamplingInput): boolean;
    };

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
    traceSeed?: TraceContext;
    baggage?: Baggage;
    sampler?: TraceSampler;
    respectRemoteSampled?: boolean;
    forceSampleOnError?: boolean;
    childName?: (parentName?: string) => string | undefined;
    clock?: RuntimeClock;
  };
};
