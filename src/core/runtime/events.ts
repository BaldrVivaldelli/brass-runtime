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
      type: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    };

export type RuntimeEmitContext = {
  fiberId?: number;
  scopeId?: number;
  traceId?: string;
  spanId?: string;
};

export interface RuntimeHooks {
  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext): void;
}

export type RuntimeEventRecord = RuntimeEvent &
  RuntimeEmitContext & {
    seq: number;
    wallTs: number; // Date.now()
    ts: number; // performance.now() si querés monotónico
  };
