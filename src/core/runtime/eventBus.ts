import {PushStatus, RingBuffer} from "./ringBuffer";
import type { RuntimeEvent } from "./events";

export type EventHandler = (ev: RuntimeEvent) => void;

type Subscriber = {
    handler: EventHandler;
    // cola por subscriber (para aislar sinks lentos)
    q: RingBuffer<RuntimeEvent>;
    dropped: number;
};

export class EventBus {
    private seq = 1;
    private subs: Subscriber[] = [];

    // cola global para drenar (opcional, pero te sirve para batch)
    private flushScheduled = false;

    subscribe(handler: EventHandler, perSubscriberCapacity = 2048) {
        this.subs.push({ handler, q: new RingBuffer(perSubscriberCapacity,perSubscriberCapacity), dropped: 0 });
        return () => {
            this.subs = this.subs.filter(s => s.handler !== handler);
        };
    }

    publish(ev: Omit<RuntimeEvent, "seq" | "ts" | "wallTs">) {
        const full: RuntimeEvent = {
            ...ev,
            seq: this.seq++,
            ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
            wallTs: Date.now(),
        };

        for (const s of this.subs) {
            const st = s.q.push(full);
            if (st & PushStatus.Dropped) s.dropped++;
                // drop silencioso; podrías emitir un evento "bus.dropped" cada tanto
        }

        // drenar asap (microtask) sin bloquear publish
        if (!this.flushScheduled) {
            this.flushScheduled = true;
            queueMicrotask(() => this.flush());
        }
    }

    flush(budget = 4096) {
        this.flushScheduled = false;
        for (const s of this.subs) {
            let n = 0;
            if (s.dropped > 0) {
                // opcional: avisar drop como pseudo-event
                s.handler({
                    seq: 0, ts: Date.now(), wallTs: Date.now(),
                    type: "log",
                    data: { level: "warn", msg: "eventbus.dropped", dropped: s.dropped } as any
                } as any);
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
