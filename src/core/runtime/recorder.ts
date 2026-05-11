import {
  makeRuntimeEventRecord,
  type RuntimeEmitContext,
  type RuntimeEvent,
  type RuntimeEventRecord,
  type RuntimeHooks,
} from "./events";
import { Cause } from "../types/effect";

export type RuntimeRecorderOptions = {
  readonly maxEvents?: number;
};

export type RuntimeRecorderStats = {
  readonly size: number;
  readonly capacity: number;
  readonly dropped: number;
  readonly firstSeq?: number;
  readonly lastSeq?: number;
};

export type RuntimeRecorderExplainOptions = {
  readonly maxEvents?: number;
};

export type RuntimeRecorder = RuntimeHooks & {
  readonly hooks: RuntimeHooks;
  readonly snapshot: () => readonly RuntimeEventRecord[];
  readonly clear: () => void;
  readonly stats: () => RuntimeRecorderStats;
  readonly explain: (options?: RuntimeRecorderExplainOptions) => string;
};

export function makeRuntimeRecorder(options: RuntimeRecorderOptions = {}): RuntimeRecorder {
  const capacity = Math.max(1, Math.floor(options.maxEvents ?? 2048));
  const records: Array<RuntimeEventRecord | undefined> = new Array(capacity);
  let next = 0;
  let size = 0;
  let dropped = 0;
  let seq = 1;

  const snapshot = (): readonly RuntimeEventRecord[] => {
    const out: RuntimeEventRecord[] = [];
    const start = size === capacity ? next : 0;
    for (let i = 0; i < size; i++) {
      const record = records[(start + i) % capacity];
      if (record) out.push(record);
    }
    return out;
  };

  const emit = (ev: RuntimeEvent, ctx: RuntimeEmitContext): void => {
    records[next] = makeRuntimeEventRecord(ev, ctx, seq++);
    next = (next + 1) % capacity;
    if (size < capacity) size++;
    else dropped++;
  };

  const clear = (): void => {
    records.fill(undefined);
    next = 0;
    size = 0;
    dropped = 0;
  };

  const stats = (): RuntimeRecorderStats => {
    const current = snapshot();
    return {
      size,
      capacity,
      dropped,
      ...(current[0] ? { firstSeq: current[0].seq } : {}),
      ...(current[current.length - 1] ? { lastSeq: current[current.length - 1]!.seq } : {}),
    };
  };

  const recorder = {
    emit,
    snapshot,
    clear,
    stats,
    explain: (explainOptions = {}) => explainRuntimeEvents(snapshot(), dropped, explainOptions),
  };
  return Object.assign(recorder, { hooks: recorder });
}

function explainRuntimeEvents(
  events: readonly RuntimeEventRecord[],
  dropped: number,
  options: RuntimeRecorderExplainOptions,
): string {
  const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 80));
  const slice = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
  const fiberStarts = new Map<number, RuntimeEventRecord>();
  const fiberSuspends = new Map<number, RuntimeEventRecord>();
  const lines = [`Runtime flight recorder: ${events.length} event${events.length === 1 ? "" : "s"}${dropped > 0 ? `, ${dropped} dropped` : ""}.`];

  for (const event of slice) {
    switch (event.type) {
      case "fiber.start": {
        fiberStarts.set(event.fiberId, event);
        lines.push(`fiber#${event.fiberId} started${event.name ? ` "${event.name}"` : ""}${event.parentFiberId !== undefined ? ` parent=fiber#${event.parentFiberId}` : ""}`);
        break;
      }
      case "fiber.suspend": {
        fiberSuspends.set(event.fiberId, event);
        lines.push(`fiber#${event.fiberId} suspended awaiting ${event.reason ?? "unknown"}`);
        break;
      }
      case "fiber.resume": {
        const suspended = fiberSuspends.get(event.fiberId);
        fiberSuspends.delete(event.fiberId);
        lines.push(`fiber#${event.fiberId} resumed${suspended ? ` after ${durationMs(suspended, event)} awaiting ${fiberSuspendReason(suspended)}` : ""}`);
        break;
      }
      case "fiber.end": {
        const started = fiberStarts.get(event.fiberId);
        const suspended = fiberSuspends.get(event.fiberId);
        fiberSuspends.delete(event.fiberId);
        lines.push(`fiber#${event.fiberId} ended ${event.status}${started ? ` after ${durationMs(started, event)}` : ""}${suspended ? ` while awaiting ${fiberSuspendReason(suspended)}` : ""}${event.error ? ` error=${formatUnknown(event.error)}` : ""}`);
        break;
      }
      case "scope.open":
        lines.push(`scope#${event.scopeId} opened${event.parentScopeId !== undefined ? ` parent=scope#${event.parentScopeId}` : ""}`);
        break;
      case "scope.close":
        lines.push(`scope#${event.scopeId} closed ${event.status}${event.error ? ` error=${formatUnknown(event.error)}` : ""}`);
        break;
      case "supervisor.child.restart":
        lines.push(`supervisor#${event.supervisorId} restarting child#${event.childId} attempt=${event.restartCount} delay=${event.delayMs}ms${event.reason ? ` reason=${event.reason}` : ""}`);
        break;
      case "supervisor.child.escalate":
        lines.push(`supervisor#${event.supervisorId} escalated child#${event.childId}${event.reason ? ` reason=${event.reason}` : ""}${event.error ? ` error=${formatUnknown(event.error)}` : ""}`);
        break;
      case "schedule.decision":
        lines.push(`schedule${event.name ? ` "${event.name}"` : ""} attempt=${event.attempt} ${event.continue ? "continues" : "stops"} delay=${event.delayMs}ms elapsed=${Math.round(event.elapsedMs)}ms${event.reason ? ` reason=${event.reason}` : ""}`);
        break;
      case "log":
        if (event.level === "warn" || event.level === "error") {
          lines.push(`${event.level}: ${event.message ?? ""}${event.fields ? ` ${JSON.stringify(event.fields)}` : ""}`);
        }
        break;
      case "span.start":
        lines.push(`span started "${event.name}"${event.traceId ? ` trace=${event.traceId}` : ""}`);
        break;
      case "span.end":
        lines.push(`span ended ${event.status}${event.name ? ` "${event.name}"` : ""}${event.error ? ` error=${formatUnknown(event.error)}` : ""}`);
        break;
      default:
        break;
    }
  }

  for (const suspended of fiberSuspends.values()) {
    lines.push(`fiber#${suspended.fiberId} still suspended for ${durationFromNowMs(suspended)} awaiting ${fiberSuspendReason(suspended)}`);
  }

  return lines.join("\n");
}

function durationMs(start: RuntimeEventRecord, end: RuntimeEventRecord): string {
  return `${Math.max(0, Math.round(end.wallTs - start.wallTs))}ms`;
}

function durationFromNowMs(start: RuntimeEventRecord): string {
  return `${Math.max(0, Math.round(Date.now() - start.wallTs))}ms`;
}

function formatUnknown(value: unknown): string {
  if (Cause.isCause(value)) return Cause.pretty(value, { singleLine: true });
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fiberSuspendReason(record: RuntimeEventRecord): string {
  return record.type === "fiber.suspend" ? record.reason ?? "unknown" : "unknown";
}
