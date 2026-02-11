import { PushStatus, RingBuffer } from "./ringBuffer";
import type { RuntimeEmitContext, RuntimeEvent, RuntimeEventRecord, RuntimeHooks } from "./events";

export type EventHandler = (ev: RuntimeEventRecord) => void;

type Subscriber = {
  handler: EventHandler;
  // cola por subscriber (para aislar sinks lentos)
  q: RingBuffer<RuntimeEventRecord>;
  dropped: number;
};

export class EventBus implements RuntimeHooks {
  private seq = 1;
  private subs: Subscriber[] = [];
  private flushScheduled = false;

  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
    const full: RuntimeEventRecord = {
      ...ev,
      ...ctx,
      seq: this.seq++,
      ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
      wallTs: Date.now(),
    };

    for (const s of this.subs) {
      const st = s.q.push(full);
      if (st & PushStatus.Dropped) s.dropped++;
    }

    // drenar asap (microtask) sin bloquear emit
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  subscribe(handler: EventHandler, perSubscriberCapacity = 2048) {
    this.subs.push({
      handler,
      q: new RingBuffer<RuntimeEventRecord>(perSubscriberCapacity, perSubscriberCapacity),
      dropped: 0,
    });

    return () => {
      this.subs = this.subs.filter((s) => s.handler !== handler);
    };
  }

  flush(budget = 4096) {
    this.flushScheduled = false;

    for (const s of this.subs) {
      let n = 0;

      if (s.dropped > 0) {
        // avisar drop como evento "log" del modelo nuevo
        const dropEv: RuntimeEventRecord = {
          seq: 0,
          ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
          wallTs: Date.now(),
          type: "log",
          level: "warn",
          message: "eventbus.dropped",
          fields: { dropped: s.dropped },
        };

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
