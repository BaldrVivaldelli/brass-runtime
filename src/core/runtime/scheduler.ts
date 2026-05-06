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

export type SchedulerEngine = "ts" | "wasm";
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
    enqueue_batch(task_refs: Uint32Array, tags: string[]): Uint32Array;
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
        this.queue = makeBoundedRingBuffer<QueuedTask>(initial, max, { engine: "ts" });
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

    constructor(readonly options: SchedulerOptions) {}

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
    enqueueBatch(tasks: Array<{ task: Task; tag: string }>): number[] {
        const refs: number[] = [];
        const tags: string[] = [];
        for (const { task, tag } of tasks) {
            const ref = this.nextRef++;
            this.tasks.set(ref, task);
            this.tags.set(ref, tag);
            refs.push(ref);
            tags.push(tag);
        }
        const policies = this.machine.enqueue_batch(new Uint32Array(refs), tags);
        // Cleanup dropped tasks
        for (let i = 0; i < policies.length; i++) {
            if (policies[i] === 3) {
                this.tasks.delete(refs[i]);
                this.tags.delete(refs[i]);
            }
        }
        return Array.from(policies);
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
    let key = "";
    let previousWasColon = false;

    for (const ch of value.trim()) {
        if (isLaneWhitespace(ch)) {
            if (!previousWasColon && key.length > 0) key += ":";
            previousWasColon = true;
            continue;
        }

        if (isAsciiAlphaNumeric(ch) || ch === "_" || ch === "." || ch === ":" || ch === "/" || ch === "#" || ch === "-") {
            key += ch;
            previousWasColon = ch === ":";
        } else {
            key += "_";
            previousWasColon = false;
        }

        if (key.length >= 160) break;
    }

    return key.length > 0 ? key : "anonymous";
}

function isLaneWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isAsciiAlphaNumeric(ch: string): boolean {
    if (ch.length !== 1) return false;
    const code = ch.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function laneTag(lane: string, tag: string = "task"): string {
    return `lane:${sanitizeLaneKey(lane)}|${tag}`;
}

function extractStackLocation(line: string): string | undefined {
    const raw = extractParenthesizedLocation(line) ?? extractAtLocation(line);
    if (!raw) return undefined;
    return stripLineAndColumn(raw);
}

function extractParenthesizedLocation(line: string): string | undefined {
    const closeIdx = line.lastIndexOf(")");
    if (closeIdx <= 0) return undefined;

    const openIdx = line.lastIndexOf("(", closeIdx - 1);
    if (openIdx < 0 || openIdx + 1 >= closeIdx) return undefined;

    return line.slice(openIdx + 1, closeIdx).trim();
}

function extractAtLocation(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) return undefined;

    const afterAt = trimmed.slice(3).trimStart();
    if (!afterAt) return undefined;

    const lastSpace = afterAt.lastIndexOf(" ");
    return (lastSpace >= 0 ? afterAt.slice(lastSpace + 1) : afterAt).trim();
}

function stripLineAndColumn(location: string): string {
    let out = location.trim();
    out = stripTrailingNumericSegment(out);
    out = stripTrailingNumericSegment(out);
    return out;
}

function stripTrailingNumericSegment(value: string): string {
    const colon = value.lastIndexOf(":");
    if (colon < 0 || colon + 1 >= value.length) return value;
    for (let i = colon + 1; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 48 || code > 57) return value;
    }
    return value.slice(0, colon);
}

function normalizeSlashes(value: string): string {
    return value.replaceAll("\\", "/").trim();
}

function isPseudoStackLocation(location: string): boolean {
    const normalized = normalizeSlashes(location);
    return (
        normalized === "<anonymous>" ||
        normalized === "anonymous" ||
        normalized.startsWith("node:") ||
        normalized.includes("/node_modules/") ||
        normalized.startsWith("node_modules/")
    );
}

function isInternalRuntimeFrame(location: string, line: string): boolean {
    const normalized = normalizeSlashes(location);
    const frame = normalizeSlashes(line);

    return (
        isRuntimeSourcePath(normalized) ||
        isRuntimeDistFile(normalized) ||
        normalized.includes("/node_modules/brass-runtime/") ||
        normalized.endsWith("/node_modules/brass-runtime") ||
        INTERNAL_FRAME_TOKENS.some((token) => frame.includes(token))
    );
}

const INTERNAL_FRAME_TOKENS = [
    "inferCallerLaneFromStack",
    "Runtime.",
    "RuntimeFiber.",
    "EngineFiberHandle.",
    "WasmFiberEngine.",
    "JsFiberEngine.",
    "Scheduler.",
];

function isRuntimeSourcePath(path: string): boolean {
    const marker = "src/core/runtime/";
    const idx = path.startsWith(marker) ? 0 : path.indexOf(`/${marker}`);
    if (idx < 0) return false;

    const offset = idx === 0 ? marker.length : idx + marker.length + 1;
    const rest = path.slice(offset);

    return rest !== "__tests__" && !rest.startsWith("__tests__/");
}

function isRuntimeDistFile(path: string): boolean {
    if (!hasPathSegment(path, "dist")) return false;

    const file = basename(path);
    const stem = dropKnownExtension(file);

    if (stem === file) return false;
    return stem === "index" || stem.includes("runtime");
}

function hasPathSegment(path: string, segment: string): boolean {
    return normalizeSlashes(path).split("/").includes(segment);
}

function basename(path: string): string {
    const normalized = normalizeSlashes(path);
    const slash = normalized.lastIndexOf("/");
    return slash < 0 ? normalized : normalized.slice(slash + 1);
}

function normalizeCallerLocation(location: string): string {
    let out = normalizeSlashes(location);
    if (out.startsWith("file://")) out = out.slice("file://".length);

    const srcIdx = out.lastIndexOf("/src/");
    if (srcIdx >= 0) {
        out = out.slice(srcIdx + 5);
    } else {
        const cwd = typeof process !== "undefined" ? normalizeSlashes(process.cwd()) : "";
        if (cwd && out.startsWith(cwd + "/")) out = out.slice(cwd.length + 1);
        out = lastPathSegments(out, 2);
    }

    return dropKnownExtension(out);
}

function lastPathSegments(path: string, count: number): string {
    const parts = normalizeSlashes(path).split("/").filter((part) => part.length > 0);
    if (parts.length <= count) return path;
    return parts.slice(parts.length - count).join("/");
}

function dropKnownExtension(path: string): string {
    const extensions = [".tsx", ".mts", ".cts", ".jsx", ".mjs", ".cjs", ".ts", ".js"];

    for (const ext of extensions) {
        if (path.endsWith(ext)) return path.slice(0, -ext.length);
    }

    return path;
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

// Lane key cache to avoid repeated string processing for the same tag
const laneKeyCache = new Map<string, string>();
const LANE_CACHE_MAX = 1024;

function inferLane(tag: string): string {
    let cached = laneKeyCache.get(tag);
    if (cached !== undefined) return cached;

    const explicit = extractTaggedLane(tag, "lane:");
    if (explicit) { cached = sanitizeLaneKey(explicit); }
    else {
        const caller = extractTaggedLane(tag, "caller:");
        if (caller) { cached = sanitizeLaneKey(caller); }
        else {
            const firstSep = firstSeparatorIndex(tag);
            const first = firstSep < 0 ? tag : tag.slice(0, firstSep);
            cached = sanitizeLaneKey(first || "anonymous");
        }
    }

    if (laneKeyCache.size >= LANE_CACHE_MAX) laneKeyCache.clear();
    laneKeyCache.set(tag, cached);
    return cached;
}

function extractTaggedLane(tag: string, prefix: string): string | undefined {
    if (!tag.startsWith(prefix)) return undefined;
    const end = tag.indexOf("|", prefix.length);
    if (end < 0) return undefined;
    const value = tag.slice(prefix.length, end);
    return value.length > 0 ? value : undefined;
}

function firstSeparatorIndex(value: string): number {
    let best = -1;
    for (const sep of [".", "#", "/"] as const) {
        const idx = value.indexOf(sep);
        if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    return best;
}

export class Scheduler {
    private readonly engine: "ts" | "wasm";
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
        const requested = options.engine ?? "ts";

        if (requested === "wasm") {
            this.wasm = new WasmSchedulerState(options);
            this.engine = "wasm";
            this.fallbackUsed = false;
            return;
        }
        if (requested === "ts") {
            this.js = new JsSchedulerState({ ...options, engine: "ts" });
            this.engine = "ts";
            this.fallbackUsed = false;
            return;
        }
        throw new Error(`brass-runtime scheduler engine must be 'ts' or 'wasm'; received '${String(requested)}'`);
    }

    schedule(task: Task, tag: string = "anonymous"): ScheduleResult {
        if (typeof task !== "function") return "dropped";
        if (this.wasm) return this.scheduleWasm(task, tag);
        return this.scheduleJs(task, tag);
    }

    scheduleBatch(tasks: Array<{ fn: Task; tag: string }>): ScheduleResult[] {
        if (this.wasm) return this.scheduleBatchWasm(tasks);
        return tasks.map(({ fn, tag }) => this.schedule(fn, tag));
    }

    stats(): SchedulerStats {
        if (this.wasm) return this.wasm.stats();
        const js = this.js!;
        const lanes = Array.from(js.lanes.values()).map((lane) => ({ key: lane.key, len: lane.queue.length, capacity: lane.queue.capacity, enqueuedTasks: lane.enqueuedTasks, executedTasks: lane.executedTasks, droppedTasks: lane.droppedTasks }));
        return { engine: "ts", fallbackUsed: false, data: { len: js.totalLength, capacity: js.totalCapacity, phase: js.flushing ? "flushing" : js.scheduled ? "scheduled" : "idle", scheduledFlushes: js.scheduledFlushes, completedFlushes: js.completedFlushes, enqueuedTasks: js.enqueuedTasks, executedTasks: js.executedTasks, droppedTasks: js.droppedTasks, yieldedByBudget: js.yieldedByBudget, lanes } };
    }

    private scheduleWasm(task: Task, tag: string): ScheduleResult {
        const policy = this.wasm!.enqueue(task, tag);
        if (policy === 3) return "dropped";
        if (policy === 0) this.requestFlush("micro");
        else if (policy === 1) this.requestFlush("macro");
        return "accepted";
    }

    private scheduleBatchWasm(tasks: Array<{ fn: Task; tag: string }>): ScheduleResult[] {
        const validTasks: Array<{ task: Task; tag: string }> = [];
        const results: ScheduleResult[] = [];
        const indexMap: number[] = [];

        for (let i = 0; i < tasks.length; i++) {
            const { fn, tag } = tasks[i];
            if (typeof fn !== "function") {
                results.push("dropped");
            } else {
                results.push("accepted"); // tentative, may be overwritten
                indexMap.push(i);
                validTasks.push({ task: fn, tag });
            }
        }

        if (validTasks.length === 0) return results;

        const policies = this.wasm!.enqueueBatch(validTasks);
        let needsMicro = false;
        let needsMacro = false;

        for (let j = 0; j < policies.length; j++) {
            const policy = policies[j];
            const originalIdx = indexMap[j];
            if (policy === 3) {
                results[originalIdx] = "dropped";
            } else if (policy === 0) {
                needsMicro = true;
            } else if (policy === 1) {
                needsMacro = true;
            }
        }

        if (needsMicro) this.requestFlush("micro");
        else if (needsMacro) this.requestFlush("macro");

        return results;
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
