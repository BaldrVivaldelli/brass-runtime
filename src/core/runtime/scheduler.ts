// scheduler.ts
import { makeBoundedRingBuffer, type BoundedRingBuffer, type RingBufferOptions } from "./boundedRingBuffer";
import { resolveWasmModule } from "./wasmModule";
import type { EngineStats } from "./engineStats";

export type Task = () => void;

// Tunables
const FLUSH_BUDGET = 2048;      // max tasks por flush
const MICRO_THRESHOLD = 4096;   // si backlog supera esto, preferí macro
const SCHEDULER_QUEUE_CAPACITY = 8192;

const scheduleMacro = (() => {
    // Node
    if (typeof (globalThis as any).setImmediate === "function") {
        return (f: () => void) => (globalThis as any).setImmediate(f);
    }
    // Browser/Node
    if (typeof (globalThis as any).MessageChannel === "function") {
        const ch = new (globalThis as any).MessageChannel();
        let cb: null | (() => void) = null;
        ch.port1.onmessage = () => { const f = cb; cb = null; f?.(); };
        return (f: () => void) => { cb = f; ch.port2.postMessage(0); };
    }
    return (f: () => void) => setTimeout(f, 0);
})();

export type SchedulerEngine = "auto" | "js" | "wasm";
export type SchedulerStatsData = {
    len: number;
    capacity?: number;
    phase?: string;
    scheduledFlushes?: number;
    completedFlushes?: number;
    enqueuedTasks?: number;
    executedTasks?: number;
    droppedTasks?: number;
    yieldedByBudget?: number;
};
export type SchedulerStats = EngineStats<SchedulerStatsData>;
export type SchedulerOptions = RingBufferOptions & {
    engine?: SchedulerEngine;
    initialCapacity?: number;
    maxCapacity?: number;
    flushBudget?: number;
    microThreshold?: number;
};

type WasmSchedulerStateMachineCtor = new (
    initialCapacity: number,
    maxCapacity: number,
    flushBudget: number,
    microThreshold: number,
) => {
    len(): number;
    capacity(): number;
    is_flushing(): boolean;
    is_scheduled(): boolean;
    enqueue(taskRef: number): number;
    begin_flush(): number;
    shift(): number;
    end_flush(ran: number): number;
    clear(): void;
    stats_json(): string;
};

function resolveWasmScheduler(): WasmSchedulerStateMachineCtor | null {
    const mod = resolveWasmModule() as { BrassWasmSchedulerStateMachine?: WasmSchedulerStateMachineCtor } | null;
    return mod?.BrassWasmSchedulerStateMachine ?? null;
}

class JsSchedulerState {
    tasks: BoundedRingBuffer<Task>;
    tags: BoundedRingBuffer<string>;
    flushing = false;
    scheduled = false;
    scheduledFlushes = 0;
    completedFlushes = 0;
    enqueuedTasks = 0;
    executedTasks = 0;
    droppedTasks = 0;
    yieldedByBudget = 0;

    constructor(options: SchedulerOptions) {
        const initial = options.initialCapacity ?? 1024;
        const max = options.maxCapacity ?? initial;
        this.tasks = makeBoundedRingBuffer<Task>(initial, max, { engine: options.engine });
        this.tags = makeBoundedRingBuffer<string>(initial, max, { engine: options.engine });
    }
}

class WasmSchedulerState {
    readonly machine: InstanceType<WasmSchedulerStateMachineCtor>;
    private nextRef = 1;
    private readonly tasks = new Map<number, Task>();
    private readonly tags = new Map<number, string>();

    constructor(options: SchedulerOptions) {
        const Ctor = resolveWasmScheduler();
        if (!Ctor) throw new Error("brass-runtime wasm scheduler is not available. Run npm run build:wasm first.");
        this.machine = new Ctor(
            options.initialCapacity ?? 1024,
            options.maxCapacity ?? SCHEDULER_QUEUE_CAPACITY,
            options.flushBudget ?? FLUSH_BUDGET,
            options.microThreshold ?? MICRO_THRESHOLD,
        );
    }

    enqueue(task: Task, tag: string): number {
        const ref = this.nextRef++;
        this.tasks.set(ref, task);
        this.tags.set(ref, tag);
        const policy = this.machine.enqueue(ref);
        if (policy === 3) {
            this.tasks.delete(ref);
            this.tags.delete(ref);
        }
        return policy;
    }

    beginFlush(): number {
        return this.machine.begin_flush();
    }

    shift(): { task: Task; tag: string } | undefined {
        const ref = this.machine.shift();
        if (ref === 0) return undefined;
        const task = this.tasks.get(ref);
        const tag = this.tags.get(ref) ?? "anonymous";
        this.tasks.delete(ref);
        this.tags.delete(ref);
        return task ? { task, tag } : undefined;
    }

    endFlush(ran: number): number {
        return this.machine.end_flush(ran);
    }

    get length(): number {
        return this.machine.len();
    }

    stats(): SchedulerStats {
        return { engine: "wasm", fallbackUsed: false, data: JSON.parse(this.machine.stats_json()) as SchedulerStatsData };
    }
}

export class Scheduler {
    private readonly engine: "js" | "wasm";
    private readonly js?: JsSchedulerState;
    private readonly wasm?: WasmSchedulerState;
    private readonly flushBudget: number;
    private readonly microThreshold: number;
    private readonly fallbackUsed: boolean;

    // Cached flush closure — avoids creating a new closure on every requestFlush
    private readonly boundFlush = () => this.flush();

    constructor(options: SchedulerOptions = {}) {
        this.flushBudget = options.flushBudget ?? FLUSH_BUDGET;
        this.microThreshold = options.microThreshold ?? MICRO_THRESHOLD;
        const requested = options.engine ?? "js";

        if (requested === "wasm") {
            this.wasm = new WasmSchedulerState(options);
            this.engine = "wasm";
            this.fallbackUsed = false;
            return;
        }

        if (requested === "auto" && resolveWasmScheduler()) {
            this.wasm = new WasmSchedulerState(options);
            this.engine = "wasm";
            this.fallbackUsed = false;
            return;
        }

        this.js = new JsSchedulerState({ ...options, engine: "js" });
        this.engine = "js";
        this.fallbackUsed = requested === "auto";
    }

    schedule(task: Task, tag: string = "anonymous"): void {
        if (typeof task !== "function") return;
        if (this.wasm) return this.scheduleWasm(task, tag);
        this.scheduleJs(task, tag);
    }

    stats(): SchedulerStats {
        if (this.wasm) return this.wasm.stats();
        const js = this.js!;
        return {
            engine: "js",
            fallbackUsed: this.fallbackUsed,
            data: {
            len: js.tasks.length,
            capacity: js.tasks.capacity,
            phase: js.flushing ? "flushing" : js.scheduled ? "scheduled" : "idle",
            scheduledFlushes: js.scheduledFlushes,
            completedFlushes: js.completedFlushes,
            enqueuedTasks: js.enqueuedTasks,
            executedTasks: js.executedTasks,
            droppedTasks: js.droppedTasks,
            yieldedByBudget: js.yieldedByBudget,
            },
        };
    }

    private scheduleWasm(task: Task, tag: string): void {
        const policy = this.wasm!.enqueue(task, tag);
        if (policy === 0) this.requestFlush("micro");
        else if (policy === 1) this.requestFlush("macro");
    }

    private scheduleJs(task: Task, tag: string): void {
        const js = this.js!;
        const taskStatus = js.tasks.push(task);
        const tagStatus = js.tags.push(tag);
        js.enqueuedTasks++;
        if ((taskStatus & 2) !== 0 || (tagStatus & 2) !== 0) js.droppedTasks++;

        // si estamos adentro de flush, no programes más: el loop ya está drenando
        if (js.flushing) return;

        if (!js.scheduled) {
            js.scheduled = true;
            js.scheduledFlushes++;
            const kind = js.tasks.length > this.microThreshold ? "macro" : "micro";
            this.requestFlush(kind);
        }
    }

    private requestFlush(kind: "micro" | "macro"): void {
        if (kind === "micro") queueMicrotask(this.boundFlush);
        else scheduleMacro(this.boundFlush);
    }

    private flush(): void {
        if (this.wasm) return this.flushWasm();
        this.flushJs();
    }

    private flushWasm(): void {
        const wasm = this.wasm!;
        const budget = wasm.beginFlush();
        if (budget <= 0) return;

        let ran = 0;
        try {
            while (ran < budget) {
                const next = wasm.shift();
                if (!next) break;
                ran++;
                try { next.task(); }
                catch (e) { console.error(`[Scheduler] task threw (tag=${next.tag})`, e); }
            }
        } finally {
            const policy = wasm.endFlush(ran);
            if (policy === 0) this.requestFlush("micro");
            else if (policy === 1) this.requestFlush("macro");
        }
    }

    private flushJs(): void {
        const js = this.js!;
        if (js.flushing) return;

        js.flushing = true;
        js.scheduled = false;

        let ran = 0;

        try {
            while (ran < this.flushBudget) {
                const task = js.tasks.shift();
                if (!task) break;
                const tag = js.tags.shift();
                ran++;
                js.executedTasks++;
                try { task(); }
                catch (e) { console.error(`[Scheduler] task threw (tag=${tag})`, e); }
            }
        } finally {
            js.flushing = false;
            js.completedFlushes++;

            if (js.tasks.length > 0 && !js.scheduled) {
                js.scheduled = true;
                js.scheduledFlushes++;

                // si agotamos budget o hay backlog => yield al event loop
                const kind =
                    ran >= this.flushBudget || js.tasks.length > this.microThreshold
                        ? "macro"
                        : "micro";

                if (ran >= this.flushBudget) js.yieldedByBudget++;
                this.requestFlush(kind);
            }
        }
    }
}

export const globalScheduler = new Scheduler();
