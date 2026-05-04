export type HostActionKind = "http" | "db" | "queue" | "custom";

export type HttpHostAction = {
  readonly kind: "http";
  readonly actionId?: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly target: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  readonly responseLimitBytes?: number;
  readonly idempotencyKey?: string;
};

export type DbHostAction = {
  readonly kind: "db";
  readonly actionId?: string;
  readonly operation: "get" | "put" | "query" | "delete";
  readonly target: string;
  readonly payload: Uint8Array;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
};

export type QueueHostAction = {
  readonly kind: "queue";
  readonly actionId?: string;
  readonly target: string;
  readonly payload: Uint8Array;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
};

export type CustomHostAction = {
  readonly kind: "custom";
  readonly actionId?: string;
  readonly target: string;
  readonly payload?: Uint8Array;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
};

export type HostAction = HttpHostAction | DbHostAction | QueueHostAction | CustomHostAction;

export type HostActionResult<A = unknown> =
  | {
      readonly kind: "ok";
      readonly actionId?: string;
      readonly value: A;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: "error";
      readonly actionId?: string;
      readonly error: unknown;
      readonly metadata?: Record<string, unknown>;
    };

export type HostExecutionContext<R = unknown> = {
  readonly fiberId: number;
  readonly env: R;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
};

export interface HostExecutor<R = unknown> {
  execute(action: HostAction, context: HostExecutionContext<R>): Promise<HostActionResult>;
}

export const DefaultHostExecutor: HostExecutor<any> = {
  async execute(action) {
    return {
      kind: "error",
      actionId: action.actionId,
      error: new Error(`No HostExecutor configured for HostAction kind=${action.kind} target=${action.target}`),
    };
  },
};
