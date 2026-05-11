export type PerfTagValue = string | number | boolean;

export type PerfEventType = "mark" | "measure" | "counter" | "gauge";

export type PerfEvent = {
  readonly type: PerfEventType;
  readonly name: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly value?: number;
  readonly unit?: string;
  readonly tags?: Readonly<Record<string, PerfTagValue>>;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type PerfRecorderOptions = {
  readonly maxEvents?: number;
  readonly clock?: () => number;
};

export type PerfRecorderStats = {
  readonly capacity: number;
  readonly size: number;
  readonly recorded: number;
  readonly dropped: number;
};

export type PerfEventSummary = {
  readonly name: string;
  readonly type: PerfEventType;
  readonly count: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
  readonly lastTimestamp: number;
  readonly lastValue?: number;
  readonly unit?: string;
};

export type PerfRecorder = {
  readonly record: (event: Omit<PerfEvent, "timestamp"> & { readonly timestamp?: number }) => PerfEvent;
  readonly mark: (
    name: string,
    details?: Readonly<Record<string, unknown>>,
    tags?: Readonly<Record<string, PerfTagValue>>,
  ) => PerfEvent;
  readonly measure: <A>(
    name: string,
    fn: () => A,
    details?: Readonly<Record<string, unknown>>,
    tags?: Readonly<Record<string, PerfTagValue>>,
  ) => A;
  readonly measureAsync: <A>(
    name: string,
    fn: () => Promise<A>,
    details?: Readonly<Record<string, unknown>>,
    tags?: Readonly<Record<string, PerfTagValue>>,
  ) => Promise<A>;
  readonly counter: (
    name: string,
    value?: number,
    unit?: string,
    tags?: Readonly<Record<string, PerfTagValue>>,
  ) => PerfEvent;
  readonly gauge: (
    name: string,
    value: number,
    unit?: string,
    tags?: Readonly<Record<string, PerfTagValue>>,
  ) => PerfEvent;
  readonly snapshot: () => readonly PerfEvent[];
  readonly stats: () => PerfRecorderStats;
  readonly explain: () => readonly PerfEventSummary[];
  readonly clear: () => void;
};

const DEFAULT_MAX_EVENTS = 2_048;

export function makePerfRecorder(options: PerfRecorderOptions = {}): PerfRecorder {
  const capacity = normalizeCapacity(options.maxEvents);
  const clock = options.clock ?? defaultClock;
  const buffer = new Array<PerfEvent>(capacity);
  let writeIndex = 0;
  let size = 0;
  let recorded = 0;
  let dropped = 0;

  const record: PerfRecorder["record"] = (input) => {
    const event = freezeEvent({
      ...input,
      timestamp: input.timestamp ?? clock(),
    });

    if (size === capacity) {
      dropped++;
    } else {
      size++;
    }

    buffer[writeIndex] = event;
    writeIndex = (writeIndex + 1) % capacity;
    recorded++;
    return event;
  };

  const snapshot = (): readonly PerfEvent[] => {
    const out = new Array<PerfEvent>(size);
    const start = size === capacity ? writeIndex : 0;
    for (let i = 0; i < size; i++) {
      out[i] = buffer[(start + i) % capacity]!;
    }
    return Object.freeze(out);
  };

  return {
    record,
    mark: (name, details, tags) => record({ type: "mark", name, details, tags }),
    measure: (name, fn, details, tags) => {
      const startedAt = clock();
      try {
        return fn();
      } finally {
        record({
          type: "measure",
          name,
          timestamp: clock(),
          durationMs: round(clock() - startedAt),
          details,
          tags,
        });
      }
    },
    measureAsync: async (name, fn, details, tags) => {
      const startedAt = clock();
      try {
        return await fn();
      } finally {
        record({
          type: "measure",
          name,
          timestamp: clock(),
          durationMs: round(clock() - startedAt),
          details,
          tags,
        });
      }
    },
    counter: (name, value = 1, unit, tags) => record({ type: "counter", name, value, unit, tags }),
    gauge: (name, value, unit, tags) => record({ type: "gauge", name, value, unit, tags }),
    snapshot,
    stats: () => Object.freeze({ capacity, size, recorded, dropped }),
    explain: () => summarizePerfEvents(snapshot()),
    clear: () => {
      buffer.fill(undefined as unknown as PerfEvent);
      writeIndex = 0;
      size = 0;
      recorded = 0;
      dropped = 0;
    },
  };
}

export function summarizePerfEvents(events: readonly PerfEvent[]): readonly PerfEventSummary[] {
  const summaries = new Map<string, {
    name: string;
    type: PerfEventType;
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
    lastTimestamp: number;
    lastValue?: number;
    unit?: string;
  }>();

  for (const event of events) {
    const key = `${event.type}:${event.name}`;
    const current = summaries.get(key) ?? {
      name: event.name,
      type: event.type,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      lastTimestamp: event.timestamp,
    };
    const durationMs = event.durationMs ?? 0;
    current.count++;
    current.totalDurationMs = round(current.totalDurationMs + durationMs);
    current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
    current.lastTimestamp = event.timestamp;
    if (event.value !== undefined) current.lastValue = event.value;
    if (event.unit !== undefined) current.unit = event.unit;
    summaries.set(key, current);
  }

  return Object.freeze([...summaries.values()]
    .map((summary) => Object.freeze({
      ...summary,
      totalDurationMs: round(summary.totalDurationMs),
      maxDurationMs: round(summary.maxDurationMs),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)));
}

function freezeEvent(event: PerfEvent): PerfEvent {
  return Object.freeze({
    ...event,
    durationMs: event.durationMs === undefined ? undefined : round(event.durationMs),
    tags: event.tags ? Object.freeze({ ...event.tags }) : undefined,
    details: event.details ? Object.freeze({ ...event.details }) : undefined,
  });
}

function normalizeCapacity(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_EVENTS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVENTS;
  return Math.max(1, Math.floor(value));
}

function defaultClock(): number {
  return performance.now();
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
