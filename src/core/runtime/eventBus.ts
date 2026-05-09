import { PushStatus } from "./ringBuffer";
import { makeBoundedRingBuffer, type BoundedRingBuffer, type RingBufferOptions } from "./boundedRingBuffer";
import {
  makeRuntimeEventRecord,
  runtimeEventRecordContext,
  type RuntimeEmitContext,
  type RuntimeEvent,
  type RuntimeEventRecord,
  type RuntimeHooks,
} from "./events";

export type EventHandler = (ev: RuntimeEventRecord) => void;

export function runtimeHooksToEventHandler(hooks: RuntimeHooks): EventHandler {
  return (record) => {
    hooks.emit(record as RuntimeEvent, runtimeEventRecordContext(record));
  };
}

type Subscriber = {
  handler: EventHandler;
  // cola por subscriber (para aislar sinks lentos)
  q: BoundedRingBuffer<RuntimeEventRecord>;
  dropped: number;
};

export type EventBusOptions = RingBufferOptions;

export class EventBus implements RuntimeHooks {
  private seq = 1;
  private subs: Subscriber[] = [];
  private flushScheduled = false;
  private readonly boundFlush = () => this.flush();

  constructor(private readonly options: EventBusOptions = {}) {}

  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
    // 2.2.1: early return — zero-cost cuando no hay suscriptores
    if (this.subs.length === 0) return;

    // 2.2.2: construir RuntimeEventRecord solo si hay suscriptores
    const full = makeRuntimeEventRecord(ev, ctx, this.seq++);

    for (const s of this.subs) {
      const st = s.q.push(full);
      if (st & PushStatus.Dropped) s.dropped++;
    }

    // 2.2.3: usar boundFlush cacheado en lugar de crear closure nuevo
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(this.boundFlush);
    }
  }

  subscribe(handler: EventHandler, perSubscriberCapacity = 2048) {
    this.subs.push({
      handler,
      q: makeBoundedRingBuffer<RuntimeEventRecord>(perSubscriberCapacity, perSubscriberCapacity, this.options),
      dropped: 0,
    });

    return () => {
      this.subs = this.subs.filter((s) => s.handler !== handler);
    };
  }

  subscribeHooks(hooks: RuntimeHooks, perSubscriberCapacity = 2048) {
    return this.subscribe(runtimeHooksToEventHandler(hooks), perSubscriberCapacity);
  }

  flush(budget = 4096) {
    this.flushScheduled = false;

    for (const s of this.subs) {
      let n = 0;

      if (s.dropped > 0) {
        // avisar drop como evento "log" del modelo nuevo
        const dropEv = makeRuntimeEventRecord(
          {
            type: "log",
            level: "warn",
            message: "eventbus.dropped",
            fields: { dropped: s.dropped },
          },
          {},
          0
        );

        try { s.handler(dropEv); } catch {}
        s.dropped = 0;
      }

      while (n++ < budget) {
        const ev = s.q.shift();
        if (!ev) break;
        try { s.handler(ev); } catch {}
      }
    }
  }
}
