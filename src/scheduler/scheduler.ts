export type Task = () => void;

type TaggedTask = {
    tag: string;
    task: Task;
};

export class Scheduler {
    private queue: TaggedTask[] = [];
    private flushing = false;
    private requested = false;

    // ✅ tag opcional
    schedule(task: Task, tag: string = "anonymous"): void {
        this.queue.push({ tag, task });
        this.requestFlush();

        // log: tamaño + próximos tags (head)
        console.log("SCHEDULER", {
            flushing: this.flushing,
            q: this.queue.length,
            next: this.queue[0]?.tag,
            head: this.queue.slice(0, 5).map(t => t.tag),
        });
    }

    private requestFlush(): void {
        if (this.requested) return;
        this.requested = true;

        queueMicrotask(() => this.flush());
    }

    private flush(): void {
        if (this.flushing) return;
        this.flushing = true;
        this.requested = false;

        try {
            while (this.queue.length > 0) {
                const { task } = this.queue.shift()!;
                try { task(); } catch {}
            }
        } finally {
            this.flushing = false;
            if (this.queue.length > 0) this.requestFlush();
        }
    }
}

export const globalScheduler = new Scheduler();
