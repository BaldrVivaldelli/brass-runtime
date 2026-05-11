export type RuntimeEvent =
  | {
      type: "fiber.start";
      fiberId: number;
      parentFiberId?: number;
      scopeId?: number;
      name?: string;
    }
  | {
      type: "fiber.end";
      fiberId: number;
      status: "success" | "failure" | "interrupted";
      error?: unknown;
    }
  | {
      type: "fiber.suspend";
      fiberId: number;
      reason?: string;
    }
  | {
      type: "fiber.resume";
      fiberId: number;
    }
  | {
      type: "scope.open";
      scopeId: number;
      parentScopeId?: number;
    }
  | {
      type: "scope.close";
      scopeId: number;
      status: "success" | "failure" | "interrupted";
      error?: unknown;
    }
  | {
      type: "supervisor.child.start";
      supervisorId: number;
      childId: number;
      name?: string;
      restartCount: number;
    }
  | {
      type: "supervisor.child.end";
      supervisorId: number;
      childId: number;
      name?: string;
      status: "success" | "failure" | "interrupted";
      error?: unknown;
    }
  | {
      type: "supervisor.child.restart";
      supervisorId: number;
      childId: number;
      name?: string;
      restartCount: number;
      delayMs: number;
      reason?: string;
    }
  | {
      type: "supervisor.child.escalate";
      supervisorId: number;
      childId: number;
      name?: string;
      reason?: string;
      error?: unknown;
    }
  | {
      type: "supervisor.shutdown";
      supervisorId: number;
    }
  | {
      type: "schedule.decision";
      name?: string;
      attempt: number;
      elapsedMs: number;
      delayMs: number;
      continue: boolean;
      reason?: string;
      input?: unknown;
      output?: unknown;
    }
  | {
      type: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    }
  | {
      type: "span.start";
      name: string;
      attributes?: Record<string, unknown>;
      links?: RuntimeSpanLink[];
    }
  | {
      type: "span.event";
      name: string;
      attributes?: Record<string, unknown>;
    }
  | {
      type: "span.end";
      name?: string;
      status: "success" | "failure" | "interrupted";
      error?: unknown;
      attributes?: Record<string, unknown>;
    };

export type RuntimeEmitContext = {
  fiberId?: number;
  scopeId?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceState?: string;
  baggage?: Record<string, string>;
  sampled?: boolean;
};

export type RuntimeSpanLink = {
  traceId: string;
  spanId: string;
  traceState?: string;
  attributes?: Record<string, string | number | boolean>;
};

export interface RuntimeHooks {
  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext): void;
}

export type RuntimeEventRecord = RuntimeEvent &
  RuntimeEmitContext & {
    seq: number;
    wallTs: number; // Date.now()
    ts: number; // performance.now() si querés monotónico

    /**
     * The ambient fiber/scope from RuntimeEmitContext. Event payload fields
     * keep priority in the merged record, so these preserve the context when
     * an event also has a fiberId/scopeId of its own.
     */
    contextFiberId?: number;
    contextScopeId?: number;

    /**
     * Convenience fields for generic event consumers. They are present for
     * log events and absent for fiber/scope events, but keeping them optional
     * lets subscribers inspect records without narrowing the RuntimeEvent
     * union first.
     */
    level?: "debug" | "info" | "warn" | "error";
    message?: string;
    fields?: Record<string, unknown>;
  };

export function makeRuntimeEventRecord(
  ev: RuntimeEvent,
  ctx: RuntimeEmitContext,
  seq: number
): RuntimeEventRecord {
  const wallTs = Date.now();
  const ts = typeof performance !== "undefined" ? performance.now() : wallTs;

  return {
    ...ctx,
    contextFiberId: ctx.fiberId,
    contextScopeId: ctx.scopeId,
    ...ev,
    seq,
    wallTs,
    ts,
  } as RuntimeEventRecord;
}

export function runtimeEventRecordContext(record: RuntimeEventRecord): RuntimeEmitContext {
  return {
    fiberId: record.contextFiberId ?? record.fiberId,
    scopeId: record.contextScopeId ?? record.scopeId,
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    traceState: record.traceState,
    baggage: record.baggage,
    sampled: record.sampled,
  };
}
