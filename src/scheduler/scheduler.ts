export type Task = () => void;

export class Scheduler {
    private queue: Task[] = [];
    private flushing = false;

    schedule(task: Task): void {
        this.queue.push(task);
        if (!this.flushing) {
            this.flush();
        }
    }

    private flush(): void {
        this.flushing = true;

        // Versión simple: drena todo de una
        while (this.queue.length > 0) {
            const t = this.queue.shift()!;
            t();
        }

        this.flushing = false;
    }
}

// Un scheduler global para todo el runtime
export const globalScheduler = new Scheduler();
