// scheduler.ts
import { makeBoundedRingBuffer, type BoundedRingBuffer, type RingBufferOptions } from "./boundedRingBuffer";
import { resolveWasmModule } from "./wasmModule";
import type { EngineStats } from "./engineStats";

export type Task = () => void;
export type ScheduleResult = "accepted" | "dropped";
type QueuedTask = { task: Task; tag: string };

const FLUSH_BUDGET = 2048;
const MICRO_THRESHOLD = 4096;
const SCHEDULER_QUEUE_CAPACITY = 8192;
const DEFAULT_LANE_CAPACITY = 1024;
const DEFAULT_LANE_BUDGET = 64;
const DEFAULT_MAX_LANES = 256;

const scheduleMacro = (() => {
    if (typeof (globalThis as any).setImmediate === "function") return (f: () => void) => (globalThis as any).setImmediate(f);
    if (typeof (globalThis as any).MessageChannel === "function") {
        const ch = new (globalThis as any).MessageChannel();
        let cb: null | (() => void) = null;
        ch.port1.onmessage = () => { const f = cb; cb = null; f?.(); };
        return (f: () => void) => { cb = f; ch.port2.postMessage(0); };
    }
    return (f: () => void) => setTimeout(f, 0);
})();

export type SchedulerEngine = "auto" | "js" | "wasm";
export type LaneStatsData = {
    key: string;
    len: number;
    capacity: number;
    enqueuedTasks: number;
    executedTasks: number;
    droppedTasks: number;
};
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
    lanes?: LaneStatsData[];
};
export type SchedulerStats = EngineStats<SchedulerStatsData>;
export type SchedulerOptions = RingBufferOptions & {
    engine?: SchedulerEngine;
    initialCapacity?: number;
    maxCapacity?: number;
    flushBudget?: number;
    microThreshold?: number;
    /** Capacity per inferred caller lane. Overflow drops the newly enqueued task in that lane. */
    laneCapacity?: number;
    /** Max tasks a single lane can run before rotating to the next lane. */
    laneBudget?: number;
    /** Safety cap for distinct lanes. New lanes past this limit go to `overflow`. */
    maxLanes?: number;
};

type WasmSchedulerStateMachineCtor = new (
    initialCapacity: number,
    maxCapacity: number,
    flushBudget: number,
    microThreshold: number,
    laneCapacity: number,
    laneBudget: number,
    maxLanes: number,
) => {
    len(): number;
    capacity(): number;
    is_flushing(): boolean;
    is_scheduled(): boolean;
    enqueue(taskRef: number, tag: string): number;
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

class LaneState {
    readonly queue: BoundedRingBuffer<QueuedTask>;
    enqueuedTasks = 0;
    executedTasks = 0;
    droppedTasks = 0;

    constructor(readonly key: string, initial: number, max: number) {
        this.queue = makeBoundedRingBuffer<QueuedTask>(initial, max, { engine: "js" });
    }
}

class JsSchedulerState {
    readonly lanes = new Map<string, LaneState>();
    readonly laneOrder: string[] = [];
    rrIndex = 0;
    rrRemaining = 0;
    flushing = false;
    scheduled = false;
    scheduledFlushes = 0;
    completedFlushes = 0;
    enqueuedTasks = 0;
    executedTasks = 0;
    droppedTasks = 0;
    yieldedByBudget = 0;

    constructor(readonly options: SchedulerOptions) { }

    get totalLength(): number {
        let n = 0;
        for (const lane of this.lanes.values()) n += lane.queue.length;
        return n;
    }
    get totalCapacity(): number {
        let n = 0;
        for (const lane of this.lanes.values()) n += lane.queue.capacity;
        return n;
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
            options.laneCapacity ?? DEFAULT_LANE_CAPACITY,
            options.laneBudget ?? DEFAULT_LANE_BUDGET,
            options.maxLanes ?? DEFAULT_MAX_LANES,
        );
    }
    enqueue(task: Task, tag: string): number {
        const ref = this.nextRef++;
        this.tasks.set(ref, task);
        this.tags.set(ref, tag);
        const policy = this.machine.enqueue(ref, tag);
        if (policy === 3) { this.tasks.delete(ref); this.tags.delete(ref); }
        return policy;
    }
    beginFlush(): number { return this.machine.begin_flush(); }
    shift(): { task: Task; tag: string } | undefined {
        const ref = this.machine.shift();
        if (ref === 0) return undefined;
        const task = this.tasks.get(ref);
        const tag = this.tags.get(ref) ?? "anonymous";
        this.tasks.delete(ref); this.tags.delete(ref);
        return task ? { task, tag } : undefined;
    }
    endFlush(ran: number): number { return this.machine.end_flush(ran); }
    stats(): SchedulerStats { return { engine: "wasm", fallbackUsed: false, data: JSON.parse(this.machine.stats_json()) as SchedulerStatsData }; }
}

export function sanitizeLaneKey(value: string): string {
    const trimmed = value.trim();
    let key = "";
    let inWhitespace = false;

    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
            if (!inWhitespace) {
                key += ":";
                inWhitespace = true;
            }
        } else {
            inWhitespace = false;
            if (
                (char >= 'a' && char <= 'z') ||
                (char >= 'A' && char <= 'Z') ||
                (char >= '0' && char <= '9') ||
                char === '_' || char === '.' || char === ':' || char === '/' || char === '#' || char === '-'
            ) {
                key += char;
            } else {
                key += "_";
            }
        }
    }

    return key.length > 0 ? key.slice(0, 160) : "anonymous";
}

export function laneTag(lane: string, tag: string = "task"): string {
    return `lane:${sanitizeLaneKey(lane)}|${tag}`;
}

function isDigits(str: string): boolean {
    if (str.length === 0) return false;
    for (let i = 0; i < str.length; i++) {
        if (str[i] < '0' || str[i] > '9') return false;
    }
    return true;
}

function extractStackLocation(line: string): string | undefined {
    let raw: string | undefined;

    const openParen = line.indexOf("(");
    const closeParen = line.indexOf(")", openParen);

    if (openParen !== -1 && closeParen !== -1) {
        raw = line.slice(openParen + 1, closeParen);
    } else {
        const trimmed = line.trim();
        const atIndex = trimmed.indexOf("at ");
        if (atIndex !== -1) {
            raw = trimmed.slice(atIndex + 3).trim();
        }
    }

    if (!raw) return undefined;

    const parts = raw.split(":");
    if (parts.length > 1) {
        const last = parts[parts.length - 1];
        if (isDigits(last)) {
            parts.pop();
            if (parts.length > 1) {
                const secondLast = parts[parts.length - 1];
                if (isDigits(secondLast)) {
                    parts.pop();
                }
            }
        }
        raw = parts.join(":");
    }

    return raw;
}

function isPseudoStackLocation(location: string): boolean {
    const normalized = location.trim().split("\\").join("/");
    return (
        normalized === "<anonymous>" ||
        normalized === "anonymous" ||
        normalized.startsWith("node:") ||
        normalized.startsWith("node_modules/") ||
        normalized.includes("/node_modules/")
    );
}

function isInternalRuntimeFrame(location: string, line: string): boolean {
    const normalized = location.split("\\").join("/");
    const frame = line.split("\\").join("/");

    const isSrcRuntime = normalized.startsWith("src/core/runtime/") || normalized.includes("/src/core/runtime/");
    const isTest = normalized.includes("src/core/runtime/__tests__/") || normalized.endsWith("src/core/runtime/__tests__");
    if (isSrcRuntime && !isTest) return true;

    const isDistRuntime =
        (normalized.startsWith("dist/") || normalized.includes("/dist/")) &&
        (normalized.includes("index.") || normalized.includes("runtime."));

    if (isDistRuntime) {
        if (normalized.endsWith(".mjs") || normalized.endsWith(".cjs") || normalized.endsWith(".js")) {
            return true;
        }
    }

    const isBrassRuntime = normalized.startsWith("node_modules/brass-runtime/") ||
        normalized.includes("/node_modules/brass-runtime/") ||
        normalized === "node_modules/brass-runtime" ||
        normalized.endsWith("/node_modules/brass-runtime");
    if (isBrassRuntime) return true;

    const internalMethods = [
        "inferCallerLaneFromStack", "Runtime.", "RuntimeFiber.",
        "EngineFiberHandle.", "WasmFiberEngine.", "JsFiberEngine.", "Scheduler."
    ];
    for (const method of internalMethods) {
        if (frame.includes(method)) return true;
    }

    return false;
}

function normalizeCallerLocation(location: string): string {
    let out = location.split("\\").join("/");
    if (out.startsWith("file://")) out = out.slice(7);

    const srcIdx = out.lastIndexOf("/src/");
    if (srcIdx >= 0) {
        out = out.slice(srcIdx + 5);
    } else {
        let cwd = "";
        if (typeof process !== "undefined" && process.cwd) {
            cwd = process.cwd().split("\\").join("/");
        }
        if (cwd && out.startsWith(cwd + "/")) {
            out = out.slice(cwd.length + 1);
        }

        const parts = out.split("/");
        if (parts.length > 2) {
            out = parts.slice(-2).join("/");
        }
    }

    const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
    for (const ext of extensions) {
        if (out.endsWith(ext)) {
            out = out.slice(0, -ext.length);
            break;
        }
    }

    return out;
}

/**
 * Infers a logical caller lane from the first non-Brass frame in the stack.
 * This keeps Brass implementation-agnostic: the first task/fiber gets a stable
 * key derived from the upper layer that invoked the runtime, and children inherit it.
 */
export function inferCallerLaneFromStack(stack: string | undefined = new Error().stack, fallback = "anonymous"): string {
    const lines = (stack ?? "").split("\n").slice(1);
    for (const line of lines) {
        const location = extractStackLocation(line);
        if (!location) continue;
        if (isPseudoStackLocation(location)) continue;
        if (isInternalRuntimeFrame(location, line)) continue;
        return sanitizeLaneKey(normalizeCallerLocation(location));
    }
    return sanitizeLaneKey(fallback);
}

function inferLane(tag: string): string {
    if (tag.startsWith("lane:")) {
        const pipeIdx = tag.indexOf("|");
        if (pipeIdx !== -1) return sanitizeLaneKey(tag.slice(5, pipeIdx));
    }
    if (tag.startsWith("caller:")) {
        const pipeIdx = tag.indexOf("|");
        if (pipeIdx !== -1) return sanitizeLaneKey(tag.slice(7, pipeIdx));
    }

    let first = tag;
    let earliestIdx = tag.length;
    const separators = ['.', '#', '/'];

    for (const sep of separators) {
        const idx = tag.indexOf(sep);
        if (idx !== -1 && idx < earliestIdx) {
            earliestIdx = idx;
        }
    }

    first = tag.slice(0, earliestIdx);
    return sanitizeLaneKey(first || "anonymous");
}

export class Scheduler {
    private readonly engine: "js" | "wasm";
    private readonly js?: JsSchedulerState;
    private readonly wasm?: WasmSchedulerState;
    private readonly flushBudget: number;
    private readonly microThreshold: number;
    private readonly laneCapacity: number;
    private readonly laneBudget: number;
    private readonly maxLanes: number;
    private readonly fallbackUsed: boolean;
    private readonly boundFlush = () => this.flush();

    constructor(options: SchedulerOptions = {}) {
        this.flushBudget = options.flushBudget ?? FLUSH_BUDGET;
        this.microThreshold = options.microThreshold ?? MICRO_THRESHOLD;
        this.laneCapacity = options.laneCapacity ?? DEFAULT_LANE_CAPACITY;
        this.laneBudget = options.laneBudget ?? DEFAULT_LANE_BUDGET;
        this.maxLanes = options.maxLanes ?? DEFAULT_MAX_LANES;
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

    schedule(task: Task, tag: string = "anonymous"): ScheduleResult {
        if (typeof task !== "function") return "dropped";
        if (this.wasm) return this.scheduleWasm(task, tag);
        return this.scheduleJs(task, tag);
    }

    stats(): SchedulerStats {
        if (this.wasm) return this.wasm.stats();
        const js = this.js!;
        const lanes = Array.from(js.lanes.values()).map((lane) => ({ key: lane.key, len: lane.queue.length, capacity: lane.queue.capacity, enqueuedTasks: lane.enqueuedTasks, executedTasks: lane.executedTasks, droppedTasks: lane.droppedTasks }));
        return { engine: "js", fallbackUsed: this.fallbackUsed, data: { len: js.totalLength, capacity: js.totalCapacity, phase: js.flushing ? "flushing" : js.scheduled ? "scheduled" : "idle", scheduledFlushes: js.scheduledFlushes, completedFlushes: js.completedFlushes, enqueuedTasks: js.enqueuedTasks, executedTasks: js.executedTasks, droppedTasks: js.droppedTasks, yieldedByBudget: js.yieldedByBudget, lanes } };
    }

    private scheduleWasm(task: Task, tag: string): ScheduleResult {
        const policy = this.wasm!.enqueue(task, tag);
        if (policy === 3) return "dropped";
        if (policy === 0) this.requestFlush("micro");
        else if (policy === 1) this.requestFlush("macro");
        return "accepted";
    }

    private getOrCreateLane(key: string): LaneState {
        const js = this.js!;
        const existing = js.lanes.get(key);
        if (existing) return existing;
        if (js.lanes.size >= this.maxLanes) return js.lanes.get("overflow") ?? this.createLane("overflow");
        return this.createLane(key);
    }
    private createLane(key: string): LaneState {
        const js = this.js!;
        const lane = new LaneState(key, this.laneCapacity, this.laneCapacity);
        js.lanes.set(key, lane);
        js.laneOrder.push(key);
        return lane;
    }

    private scheduleJs(task: Task, tag: string): ScheduleResult {
        const js = this.js!;
        const lane = this.getOrCreateLane(inferLane(tag));
        const status = lane.queue.push({ task, tag });
        lane.enqueuedTasks++; js.enqueuedTasks++;

        if ((status & 2) !== 0) {
            lane.droppedTasks++; js.droppedTasks++;
            if (!js.flushing && !js.scheduled && js.totalLength > 0) {
                js.scheduled = true;
                js.scheduledFlushes++;
                this.requestFlush(js.totalLength > this.microThreshold ? "macro" : "micro");
            }
            return "dropped";
        }

        if (js.flushing) return "accepted";
        if (!js.scheduled) {
            js.scheduled = true;
            js.scheduledFlushes++;
            this.requestFlush(js.totalLength > this.microThreshold ? "macro" : "micro");
        }
        return "accepted";
    }

    private requestFlush(kind: "micro" | "macro"): void {
        if (kind === "micro") queueMicrotask(this.boundFlush);
        else scheduleMacro(this.boundFlush);
    }
    private flush(): void { if (this.wasm) return this.flushWasm(); this.flushJs(); }

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
                try { next.task(); } catch (e) { console.error(`[Scheduler] task threw (tag=${next.tag})`, e); }
            }
        } finally {
            const policy = wasm.endFlush(ran);
            if (policy === 0) this.requestFlush("micro");
            else if (policy === 1) this.requestFlush("macro");
        }
    }

    private shiftFromNextLane(): QueuedTask | undefined {
        const js = this.js!;
        const n = js.laneOrder.length;
        if (n === 0) return undefined;
        if (js.rrRemaining > 0) {
            const currentIdx = (js.rrIndex + n - 1) % n;
            const currentLane = js.lanes.get(js.laneOrder[currentIdx]);
            const next = currentLane?.queue.shift();
            if (next) { js.rrRemaining--; return next; }
            js.rrRemaining = 0;
        }
        for (let scanned = 0; scanned < n; scanned++) {
            const idx = js.rrIndex % n;
            const key = js.laneOrder[idx];
            js.rrIndex = (idx + 1) % n;
            const lane = js.lanes.get(key);
            if (!lane || lane.queue.length === 0) continue;
            js.rrRemaining = Math.max(0, this.laneBudget - 1);
            return lane.queue.shift();
        }
        return undefined;
    }

    private flushJs(): void {
        const js = this.js!;
        if (js.flushing) return;
        js.flushing = true;
        js.scheduled = false;
        let ran = 0;
        try {
            while (ran < this.flushBudget) {
                const next = this.shiftFromNextLane();
                if (!next) break;
                const lane = js.lanes.get(inferLane(next.tag));
                ran++; js.executedTasks++; if (lane) lane.executedTasks++;
                try { next.task(); } catch (e) { console.error(`[Scheduler] task threw (tag=${next.tag})`, e); }
            }
        } finally {
            js.flushing = false;
            js.completedFlushes++;
            if (js.totalLength > 0 && !js.scheduled) {
                js.scheduled = true;
                js.scheduledFlushes++;
                const kind = ran >= this.flushBudget || js.totalLength > this.microThreshold ? "macro" : "micro";
                if (ran >= this.flushBudget) js.yieldedByBudget++;
                this.requestFlush(kind);
            }
        }
    }
}

export const globalScheduler = new Scheduler();
