export type Task = () => void;

type TaggedTask = {
    tag: string;
    task: Task;
};

export class Scheduler {
    private queue: TaggedTask[] = [];
    private flushing = false;
    private requested = false;

    schedule(task: Task, tag: string = "anonymous"): void {
        console.log("[Scheduler.schedule] typeof task =", typeof task, "tag=", tag);

        if (typeof task !== "function") {
            console.error("[Scheduler.schedule] NON-FUNCTION TASK!", { tag, task });
            return;
        }

        this.queue.push({ tag, task });
        this.requestFlush();
        console.log("SCHEDULER", {
            flushing: this.flushing,
            q: this.queue.length,
            next: this.queue[0]?.tag,
            head: this.queue.slice(0, 5).map(t => t.tag),
        });
    }

    private requestFlush(): void {
        console.log("requestFlush", { flushing: this.flushing, requested: this.requested, q: this.queue.length });

        if (this.flushing) return;
        if (this.requested) return;
        this.requested = true;

        queueMicrotask(() => {
            console.log(">> microtask fired", { flushing: this.flushing, requested: this.requested, q: this.queue.length });
            this.flush();
        });
    }

    private flush(): void {
        console.log("FLUSH enter", { flushing: this.flushing, requested: this.requested, q: this.queue.length });

        if (this.flushing) return;
        this.flushing = true;
        this.requested = false;

        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift()!;
                console.log("[flush] dequeued", { tag: item.tag, typeofTask: typeof item.task });

                try {
                    console.log("TASK typeof", typeof item.task)
                    item.task(); // <- si esto falla, lo vas a ver
                } catch (e) {
                    console.error("[flush] task threw", e);
                }
            }
        } finally {
            this.flushing = false;
            console.log("FLUSH exit", { requested: this.requested, q: this.queue.length });
            if (this.queue.length > 0) this.requestFlush();
        }
    }
}

export const globalScheduler = new Scheduler();
