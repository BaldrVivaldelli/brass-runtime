use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use js_sys::Array;

type FiberId = u32;
type NodeId = u32;
type RefId = u32;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub version: u32,
    pub root: NodeId,
    pub nodes: Vec<OpcodeNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "tag", rename_all = "PascalCase", rename_all_fields = "camelCase")]
pub enum OpcodeNode {
    Succeed { value_ref: RefId },
    Fail { error_ref: RefId },
    Sync { fn_ref: RefId },
    Async { register_ref: RefId },
    FlatMap { first: NodeId, fn_ref: RefId },
    Fold { first: NodeId, on_failure_ref: RefId, on_success_ref: RefId },
    Fork {
        effect_ref: RefId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<u32>,
    },
    HostAction {
        action_ref: RefId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode_ref: Option<RefId>,
    },
}

#[derive(Debug, Clone)]
enum Frame {
    SuccessCont { fn_ref: RefId },
    FoldCont { on_failure_ref: RefId, on_success_ref: RefId },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FiberStatus {
    Running,
    Suspended,
    Done,
    Failed,
    Interrupted,
}

struct FiberVm {
    id: FiberId,
    program: Program,
    current: Option<NodeId>,
    stack: Vec<Frame>,
    status: FiberStatus,
    last_event: Option<Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase", rename_all_fields = "camelCase")]
pub enum Event {
    Continue { fiber_id: FiberId },
    Done { fiber_id: FiberId, value_ref: RefId },
    Failed { fiber_id: FiberId, error_ref: RefId },
    Interrupted { fiber_id: FiberId, reason_ref: RefId },
    InvokeSync { fiber_id: FiberId, fn_ref: RefId },
    InvokeAsync { fiber_id: FiberId, register_ref: RefId },
    InvokeFlatMap { fiber_id: FiberId, fn_ref: RefId, value_ref: RefId },
    InvokeFoldFailure { fiber_id: FiberId, fn_ref: RefId, error_ref: RefId },
    InvokeFoldSuccess { fiber_id: FiberId, fn_ref: RefId, value_ref: RefId },
    InvokeFork {
        fiber_id: FiberId,
        effect_ref: RefId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<u32>,
    },
    InvokeHostAction {
        fiber_id: FiberId,
        action_ref: RefId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode_ref: Option<RefId>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VmStats {
    started: u64,
    live: usize,
    running: usize,
    suspended: usize,
    completed: u64,
    failed: u64,
    interrupted: u64,
}


const RING_STATUS_OK: u32 = 0;
const RING_STATUS_GREW: u32 = 1 << 0;
const RING_STATUS_DROPPED: u32 = 1 << 1;

#[wasm_bindgen]
pub struct BrassWasmRingBuffer {
    buf: Vec<JsValue>,
    occupied: Vec<bool>,
    head: usize,
    tail: usize,
    len: usize,
    max_cap: usize,
}

#[wasm_bindgen]
impl BrassWasmRingBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(initial_capacity: usize, max_capacity: usize) -> BrassWasmRingBuffer {
        let init_pow = next_pow2(initial_capacity.max(2));
        let max_pow = next_pow2(max_capacity.max(init_pow));
        BrassWasmRingBuffer {
            buf: vec![JsValue::UNDEFINED; init_pow],
            occupied: vec![false; init_pow],
            head: 0,
            tail: 0,
            len: 0,
            max_cap: max_pow,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn push(&mut self, value: JsValue) -> u32 {
        if self.len == self.buf.len() {
            if self.buf.len() >= self.max_cap {
                return RING_STATUS_DROPPED;
            }
            self.grow();
            self.write_tail(value);
            return RING_STATUS_OK | RING_STATUS_GREW;
        }

        self.write_tail(value);
        RING_STATUS_OK
    }

    pub fn shift(&mut self) -> JsValue {
        if self.len == 0 {
            return JsValue::UNDEFINED;
        }

        let value = self.buf[self.head].clone();
        self.buf[self.head] = JsValue::UNDEFINED;
        self.occupied[self.head] = false;
        self.head = (self.head + 1) & (self.buf.len() - 1);
        self.len -= 1;
        value
    }

    pub fn clear(&mut self) {
        // Keep the allocated storage.  Only occupied cells are cleared so we do
        // not scan a huge sparse ring on every shutdown.
        let mut idx = self.head;
        for _ in 0..self.len {
            self.buf[idx] = JsValue::UNDEFINED;
            self.occupied[idx] = false;
            idx = (idx + 1) & (self.buf.len() - 1);
        }
        self.head = 0;
        self.tail = 0;
        self.len = 0;
    }

    fn write_tail(&mut self, value: JsValue) {
        self.buf[self.tail] = value;
        self.occupied[self.tail] = true;
        self.tail = (self.tail + 1) & (self.buf.len() - 1);
        self.len += 1;
    }

    fn grow(&mut self) {
        let old_cap = self.buf.len();
        let next_cap = (old_cap * 2).min(self.max_cap);
        let mut next_buf = vec![JsValue::UNDEFINED; next_cap];
        let mut next_occupied = vec![false; next_cap];

        for i in 0..self.len {
            let old_idx = (self.head + i) & (old_cap - 1);
            next_buf[i] = self.buf[old_idx].clone();
            next_occupied[i] = self.occupied[old_idx];
        }

        self.buf = next_buf;
        self.occupied = next_occupied;
        self.head = 0;
        self.tail = self.len;
    }
}

fn next_pow2(mut n: usize) -> usize {
    if n <= 2 {
        return 2;
    }
    n -= 1;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    if usize::BITS == 64 {
        n |= n >> 32;
    }
    n + 1
}





#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkBufferStats {
    len: usize,
    max_chunk_size: usize,
    emitted_chunks: u64,
    emitted_items: u64,
    flushes: u64,
}

#[wasm_bindgen]
pub struct BrassWasmChunkBuffer {
    values: Vec<JsValue>,
    max_chunk_size: usize,
    emitted_chunks: u64,
    emitted_items: u64,
    flushes: u64,
}

#[wasm_bindgen]
impl BrassWasmChunkBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(max_chunk_size: usize) -> BrassWasmChunkBuffer {
        let size = max_chunk_size.max(1);
        BrassWasmChunkBuffer {
            values: Vec::with_capacity(size),
            max_chunk_size: size,
            emitted_chunks: 0,
            emitted_items: 0,
            flushes: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn max_chunk_size(&self) -> usize {
        self.max_chunk_size
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn is_full(&self) -> bool {
        self.values.len() >= self.max_chunk_size
    }

    pub fn push(&mut self, value: JsValue) -> bool {
        if self.values.len() >= self.max_chunk_size {
            return false;
        }
        self.values.push(value);
        true
    }

    pub fn take_chunk(&mut self) -> Array {
        self.flushes += 1;
        let out = Array::new_with_length(self.values.len() as u32);
        for (idx, value) in self.values.drain(..).enumerate() {
            out.set(idx as u32, value);
        }
        let len = out.length() as u64;
        if len > 0 {
            self.emitted_chunks += 1;
            self.emitted_items += len;
        }
        out
    }

    pub fn clear(&mut self) {
        self.values.clear();
    }

    pub fn stats_json(&self) -> String {
        serde_json::to_string(&ChunkBufferStats {
            len: self.values.len(),
            max_chunk_size: self.max_chunk_size,
            emitted_chunks: self.emitted_chunks,
            emitted_items: self.emitted_items,
            flushes: self.flushes,
        }).expect("chunk buffer stats json")
    }
}


const SCHEDULER_POLICY_MICRO: u32 = 0;
const SCHEDULER_POLICY_MACRO: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchedulerPhase {
    Idle,
    ScheduledMicro,
    ScheduledMacro,
    Flushing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerStats {
    phase: &'static str,
    len: usize,
    capacity: usize,
    scheduled_flushes: u64,
    completed_flushes: u64,
    enqueued_tasks: u64,
    executed_tasks: u64,
    dropped_tasks: u64,
    yielded_by_budget: u64,
}

#[wasm_bindgen]
pub struct BrassWasmSchedulerStateMachine {
    queue: Vec<u32>,
    head: usize,
    tail: usize,
    len: usize,
    max_cap: usize,
    phase: SchedulerPhase,
    flush_budget: usize,
    micro_threshold: usize,
    scheduled_flushes: u64,
    completed_flushes: u64,
    enqueued_tasks: u64,
    executed_tasks: u64,
    dropped_tasks: u64,
    yielded_by_budget: u64,
}

#[wasm_bindgen]
impl BrassWasmSchedulerStateMachine {
    #[wasm_bindgen(constructor)]
    pub fn new(initial_capacity: usize, max_capacity: usize, flush_budget: usize, micro_threshold: usize) -> BrassWasmSchedulerStateMachine {
        let init_pow = next_pow2(initial_capacity.max(2));
        let max_pow = next_pow2(max_capacity.max(init_pow));
        BrassWasmSchedulerStateMachine {
            queue: vec![0; init_pow],
            head: 0,
            tail: 0,
            len: 0,
            max_cap: max_pow,
            phase: SchedulerPhase::Idle,
            flush_budget: flush_budget.max(1),
            micro_threshold: micro_threshold.max(1),
            scheduled_flushes: 0,
            completed_flushes: 0,
            enqueued_tasks: 0,
            executed_tasks: 0,
            dropped_tasks: 0,
            yielded_by_budget: 0,
        }
    }

    pub fn len(&self) -> usize { self.len }
    pub fn capacity(&self) -> usize { self.queue.len() }
    pub fn is_flushing(&self) -> bool { self.phase == SchedulerPhase::Flushing }
    pub fn is_scheduled(&self) -> bool { matches!(self.phase, SchedulerPhase::ScheduledMicro | SchedulerPhase::ScheduledMacro) }

    /// Enqueue a task ref and return the scheduling policy:
    /// - 0 => schedule a micro flush
    /// - 1 => schedule a macro flush
    /// - 2 => no new flush needed
    /// - 3 => queue full / task dropped
    pub fn enqueue(&mut self, task_ref: u32) -> u32 {
        if self.len == self.queue.len() {
            if self.queue.len() >= self.max_cap {
                self.dropped_tasks += 1;
                return 3;
            }
            self.grow();
        }

        self.queue[self.tail] = task_ref;
        self.tail = (self.tail + 1) & (self.queue.len() - 1);
        self.len += 1;
        self.enqueued_tasks += 1;

        if self.phase != SchedulerPhase::Idle {
            return 2;
        }

        let policy = self.next_policy();
        self.phase = if policy == SCHEDULER_POLICY_MACRO {
            SchedulerPhase::ScheduledMacro
        } else {
            SchedulerPhase::ScheduledMicro
        };
        self.scheduled_flushes += 1;
        policy
    }

    /// Enter flushing. Returns the number of tasks this flush may run.
    pub fn begin_flush(&mut self) -> usize {
        if self.phase == SchedulerPhase::Flushing {
            return 0;
        }
        self.phase = SchedulerPhase::Flushing;
        self.flush_budget.min(self.len)
    }

    pub fn shift(&mut self) -> u32 {
        if self.len == 0 {
            return 0;
        }
        let task_ref = self.queue[self.head];
        self.queue[self.head] = 0;
        self.head = (self.head + 1) & (self.queue.len() - 1);
        self.len -= 1;
        self.executed_tasks += 1;
        task_ref
    }

    /// Finish a flush. Returns the scheduling policy for the next flush:
    /// - 0 => schedule a micro flush
    /// - 1 => schedule a macro flush
    /// - 2 => no more work
    pub fn end_flush(&mut self, ran: usize) -> u32 {
        self.completed_flushes += 1;

        if self.len == 0 {
            self.phase = SchedulerPhase::Idle;
            return 2;
        }

        let policy = if ran >= self.flush_budget {
            self.yielded_by_budget += 1;
            SCHEDULER_POLICY_MACRO
        } else {
            self.next_policy()
        };

        self.phase = if policy == SCHEDULER_POLICY_MACRO {
            SchedulerPhase::ScheduledMacro
        } else {
            SchedulerPhase::ScheduledMicro
        };
        self.scheduled_flushes += 1;
        policy
    }

    pub fn clear(&mut self) {
        self.queue.fill(0);
        self.head = 0;
        self.tail = 0;
        self.len = 0;
        self.phase = SchedulerPhase::Idle;
    }

    pub fn stats_json(&self) -> String {
        serde_json::to_string(&SchedulerStats {
            phase: match self.phase {
                SchedulerPhase::Idle => "idle",
                SchedulerPhase::ScheduledMicro => "scheduledMicro",
                SchedulerPhase::ScheduledMacro => "scheduledMacro",
                SchedulerPhase::Flushing => "flushing",
            },
            len: self.len,
            capacity: self.queue.len(),
            scheduled_flushes: self.scheduled_flushes,
            completed_flushes: self.completed_flushes,
            enqueued_tasks: self.enqueued_tasks,
            executed_tasks: self.executed_tasks,
            dropped_tasks: self.dropped_tasks,
            yielded_by_budget: self.yielded_by_budget,
        }).expect("scheduler stats json")
    }

    fn next_policy(&self) -> u32 {
        if self.len > self.micro_threshold { SCHEDULER_POLICY_MACRO } else { SCHEDULER_POLICY_MICRO }
    }

    fn grow(&mut self) {
        let old_cap = self.queue.len();
        let next_cap = (old_cap * 2).min(self.max_cap);
        let mut next_queue = vec![0; next_cap];
        for i in 0..self.len {
            let old_idx = (self.head + i) & (old_cap - 1);
            next_queue[i] = self.queue[old_idx];
        }
        self.queue = next_queue;
        self.head = 0;
        self.tail = self.len;
    }
}



const FIBER_STATE_QUEUED: u32 = 0;
const FIBER_STATE_RUNNING: u32 = 1;
const FIBER_STATE_SUSPENDED: u32 = 2;
const FIBER_STATE_DONE: u32 = 3;
const FIBER_STATE_FAILED: u32 = 4;
const FIBER_STATE_INTERRUPTED: u32 = 5;

#[derive(Debug, Clone, Copy)]
struct FiberRegistryEntry {
    state: u32,
    parent_id: u32,
    scope_id: u32,
    created_at_ms: f64,
    last_active_at_ms: f64,
    joiners: u32,
    wakeups: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FiberRegistryStats {
    live: usize,
    queued: u64,
    running: u64,
    suspended: u64,
    done: u64,
    failed: u64,
    interrupted: u64,
    wake_queue_len: usize,
    registered: u64,
    completed: u64,
    wakeups: u64,
    duplicate_wakeups: u64,
    joins: u64,
}

#[wasm_bindgen]
pub struct BrassWasmFiberRegistry {
    entries: HashMap<FiberId, FiberRegistryEntry>,
    wake_queue: Vec<FiberId>,
    wake_head: usize,
    registered: u64,
    completed: u64,
    wakeups: u64,
    duplicate_wakeups: u64,
    joins: u64,
}

#[wasm_bindgen]
impl BrassWasmFiberRegistry {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BrassWasmFiberRegistry {
        BrassWasmFiberRegistry {
            entries: HashMap::new(),
            wake_queue: Vec::new(),
            wake_head: 0,
            registered: 0,
            completed: 0,
            wakeups: 0,
            duplicate_wakeups: 0,
            joins: 0,
        }
    }

    pub fn register_fiber(&mut self, fiber_id: FiberId, parent_id: u32, scope_id: u32, now_ms: f64) -> bool {
        let existed = self.entries.contains_key(&fiber_id);
        self.entries.insert(fiber_id, FiberRegistryEntry {
            state: FIBER_STATE_RUNNING,
            parent_id,
            scope_id,
            created_at_ms: now_ms,
            last_active_at_ms: now_ms,
            joiners: 0,
            wakeups: 0,
        });
        if !existed { self.registered += 1; }
        !existed
    }

    pub fn mark_queued(&mut self, fiber_id: FiberId, now_ms: f64) -> bool {
        self.set_state(fiber_id, FIBER_STATE_QUEUED, now_ms)
    }

    pub fn mark_running(&mut self, fiber_id: FiberId, now_ms: f64) -> bool {
        self.set_state(fiber_id, FIBER_STATE_RUNNING, now_ms)
    }

    pub fn mark_suspended(&mut self, fiber_id: FiberId, now_ms: f64) -> bool {
        self.set_state(fiber_id, FIBER_STATE_SUSPENDED, now_ms)
    }

    pub fn mark_done(&mut self, fiber_id: FiberId, state: u32, now_ms: f64) -> u32 {
        match self.entries.get_mut(&fiber_id) {
            Some(entry) => {
                if entry.state < FIBER_STATE_DONE { self.completed += 1; }
                entry.state = state;
                entry.last_active_at_ms = now_ms;
                let joiners = entry.joiners;
                entry.joiners = 0;
                joiners
            }
            None => 0,
        }
    }

    pub fn drop_fiber(&mut self, fiber_id: FiberId) -> bool {
        self.entries.remove(&fiber_id).is_some()
    }

    pub fn add_joiner(&mut self, fiber_id: FiberId) -> u32 {
        match self.entries.get_mut(&fiber_id) {
            Some(entry) => {
                self.joins += 1;
                entry.joiners += 1;
                entry.joiners
            }
            None => 0,
        }
    }

    pub fn wake(&mut self, fiber_id: FiberId) -> bool {
        match self.entries.get_mut(&fiber_id) {
            Some(entry) => {
                if entry.wakeups > 0 {
                    self.duplicate_wakeups += 1;
                    return false;
                }
                entry.wakeups += 1;
                self.wakeups += 1;
                self.wake_queue.push(fiber_id);
                true
            }
            None => false,
        }
    }

    pub fn drain_wakeup(&mut self) -> FiberId {
        while self.wake_head < self.wake_queue.len() {
            let fiber_id = self.wake_queue[self.wake_head];
            self.wake_head += 1;
            if self.wake_head > 1024 && self.wake_head * 2 > self.wake_queue.len() {
                self.wake_queue.drain(0..self.wake_head);
                self.wake_head = 0;
            }
            if let Some(entry) = self.entries.get_mut(&fiber_id) {
                if entry.wakeups > 0 { entry.wakeups -= 1; }
                return fiber_id;
            }
        }
        if self.wake_head >= self.wake_queue.len() {
            self.wake_queue.clear();
            self.wake_head = 0;
        }
        0
    }

    pub fn wake_queue_len(&self) -> usize {
        self.wake_queue.len().saturating_sub(self.wake_head)
    }

    pub fn state_of(&self, fiber_id: FiberId) -> u32 {
        self.entries.get(&fiber_id).map(|e| e.state).unwrap_or(u32::MAX)
    }

    pub fn stats_json(&self) -> String {
        let mut queued = 0;
        let mut running = 0;
        let mut suspended = 0;
        let mut done = 0;
        let mut failed = 0;
        let mut interrupted = 0;
        for entry in self.entries.values() {
            match entry.state {
                FIBER_STATE_QUEUED => queued += 1,
                FIBER_STATE_RUNNING => running += 1,
                FIBER_STATE_SUSPENDED => suspended += 1,
                FIBER_STATE_DONE => done += 1,
                FIBER_STATE_FAILED => failed += 1,
                FIBER_STATE_INTERRUPTED => interrupted += 1,
                _ => {}
            }
        }
        serde_json::to_string(&FiberRegistryStats {
            live: self.entries.len(),
            queued,
            running,
            suspended,
            done,
            failed,
            interrupted,
            wake_queue_len: self.wake_queue_len(),
            registered: self.registered,
            completed: self.completed,
            wakeups: self.wakeups,
            duplicate_wakeups: self.duplicate_wakeups,
            joins: self.joins,
        }).expect("fiber registry stats json")
    }

    fn set_state(&mut self, fiber_id: FiberId, state: u32, now_ms: f64) -> bool {
        match self.entries.get_mut(&fiber_id) {
            Some(entry) => {
                entry.state = state;
                entry.last_active_at_ms = now_ms;
                true
            }
            None => false,
        }
    }
}

#[wasm_bindgen]
pub struct BrassWasmVm {
    fibers: HashMap<FiberId, FiberVm>,
    next_fiber_id: FiberId,
    started: u64,
    completed: u64,
    failed: u64,
    interrupted: u64,
}

#[wasm_bindgen]
impl BrassWasmVm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BrassWasmVm {
        BrassWasmVm {
            fibers: HashMap::new(),
            next_fiber_id: 1,
            started: 0,
            completed: 0,
            failed: 0,
            interrupted: 0,
        }
    }

    pub fn create_fiber(&mut self, program_json: &str) -> FiberId {
        let program: Program = serde_json::from_str(program_json)
            .unwrap_or_else(|err| panic!("invalid brass program: {}", err));
        let id = self.next_fiber_id;
        self.next_fiber_id += 1;
        self.started += 1;
        self.fibers.insert(id, FiberVm {
            id,
            current: Some(program.root),
            program,
            stack: Vec::new(),
            status: FiberStatus::Running,
            last_event: None,
        });
        id
    }

    pub fn poll(&mut self, fiber_id: FiberId) -> String {
        let event = match self.fibers.get_mut(&fiber_id) {
            Some(fiber) => {
                if fiber.status == FiberStatus::Suspended {
                    fiber.last_event.clone().unwrap_or(Event::Continue { fiber_id })
                } else {
                    step_fiber(fiber)
                }
            }
            None => Event::Failed { fiber_id, error_ref: 0 },
        };
        self.account_event(&event);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_value(&mut self, fiber_id: FiberId, value_ref: RefId) -> String {
        let event = match self.fibers.get_mut(&fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                success(fiber, value_ref)
            }
            None => Event::Failed { fiber_id, error_ref: 0 },
        };
        self.account_event(&event);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_error(&mut self, fiber_id: FiberId, error_ref: RefId) -> String {
        let event = match self.fibers.get_mut(&fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                failure(fiber, error_ref)
            }
            None => Event::Failed { fiber_id, error_ref: 0 },
        };
        self.account_event(&event);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_effect(&mut self, fiber_id: FiberId, root: NodeId, nodes_json: &str) -> String {
        let nodes: Vec<OpcodeNode> = serde_json::from_str(nodes_json)
            .unwrap_or_else(|err| panic!("invalid brass nodes: {}", err));
        let event = match self.fibers.get_mut(&fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                fiber.program.nodes.extend(nodes);
                fiber.current = Some(root);
                step_fiber(fiber)
            }
            None => Event::Failed { fiber_id, error_ref: 0 },
        };
        self.account_event(&event);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn interrupt(&mut self, fiber_id: FiberId, reason_ref: RefId) -> String {
        let event = match self.fibers.get_mut(&fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Interrupted;
                fiber.current = None;
                fiber.stack.clear();
                let event = Event::Interrupted { fiber_id, reason_ref };
                fiber.last_event = Some(event.clone());
                event
            }
            None => Event::Interrupted { fiber_id, reason_ref },
        };
        self.account_event(&event);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn drop_fiber(&mut self, fiber_id: FiberId) {
        self.fibers.remove(&fiber_id);
    }

    pub fn stats_json(&self) -> String {
        let mut running = 0;
        let mut suspended = 0;
        for fiber in self.fibers.values() {
            match fiber.status {
                FiberStatus::Running => running += 1,
                FiberStatus::Suspended => suspended += 1,
                _ => {}
            }
        }
        serde_json::to_string(&VmStats {
            started: self.started,
            live: self.fibers.len(),
            running,
            suspended,
            completed: self.completed,
            failed: self.failed,
            interrupted: self.interrupted,
        }).expect("stats json")
    }

    fn account_event(&mut self, event: &Event) {
        match event {
            Event::Done { .. } => self.completed += 1,
            Event::Failed { .. } => self.failed += 1,
            Event::Interrupted { .. } => self.interrupted += 1,
            _ => {}
        }
    }
}

fn step_fiber(fiber: &mut FiberVm) -> Event {
    loop {
        if fiber.status == FiberStatus::Interrupted {
            return fiber.last_event.clone().unwrap_or(Event::Interrupted { fiber_id: fiber.id, reason_ref: 0 });
        }

        let Some(current) = fiber.current else {
            return mark_failed(fiber, 0);
        };

        let Some(node) = fiber.program.nodes.get(current as usize).cloned() else {
            return mark_failed(fiber, 0);
        };

        match node {
            OpcodeNode::Succeed { value_ref } => return success(fiber, value_ref),
            OpcodeNode::Fail { error_ref } => return failure(fiber, error_ref),
            OpcodeNode::Sync { fn_ref } => {
                return suspend(fiber, Event::InvokeSync { fiber_id: fiber.id, fn_ref });
            }
            OpcodeNode::Async { register_ref } => {
                return suspend(fiber, Event::InvokeAsync { fiber_id: fiber.id, register_ref });
            }
            OpcodeNode::HostAction { action_ref, decode_ref } => {
                return suspend(fiber, Event::InvokeHostAction { fiber_id: fiber.id, action_ref, decode_ref });
            }
            OpcodeNode::Fork { effect_ref, scope_id } => {
                return suspend(fiber, Event::InvokeFork { fiber_id: fiber.id, effect_ref, scope_id });
            }
            OpcodeNode::FlatMap { first, fn_ref } => {
                fiber.stack.push(Frame::SuccessCont { fn_ref });
                fiber.current = Some(first);
            }
            OpcodeNode::Fold { first, on_failure_ref, on_success_ref } => {
                fiber.stack.push(Frame::FoldCont { on_failure_ref, on_success_ref });
                fiber.current = Some(first);
            }
        }
    }
}

fn success(fiber: &mut FiberVm, value_ref: RefId) -> Event {
    let Some(frame) = fiber.stack.pop() else {
        return mark_done(fiber, value_ref);
    };

    match frame {
        Frame::SuccessCont { fn_ref } => {
            suspend(fiber, Event::InvokeFlatMap { fiber_id: fiber.id, fn_ref, value_ref })
        }
        Frame::FoldCont { on_success_ref, .. } => {
            suspend(fiber, Event::InvokeFoldSuccess { fiber_id: fiber.id, fn_ref: on_success_ref, value_ref })
        }
    }
}

fn failure(fiber: &mut FiberVm, error_ref: RefId) -> Event {
    while let Some(frame) = fiber.stack.pop() {
        match frame {
            Frame::SuccessCont { .. } => continue,
            Frame::FoldCont { on_failure_ref, .. } => {
                return suspend(fiber, Event::InvokeFoldFailure { fiber_id: fiber.id, fn_ref: on_failure_ref, error_ref });
            }
        }
    }
    mark_failed(fiber, error_ref)
}

fn suspend(fiber: &mut FiberVm, event: Event) -> Event {
    fiber.status = FiberStatus::Suspended;
    fiber.last_event = Some(event.clone());
    event
}

fn mark_done(fiber: &mut FiberVm, value_ref: RefId) -> Event {
    fiber.status = FiberStatus::Done;
    fiber.current = None;
    let event = Event::Done { fiber_id: fiber.id, value_ref };
    fiber.last_event = Some(event.clone());
    event
}

fn mark_failed(fiber: &mut FiberVm, error_ref: RefId) -> Event {
    fiber.status = FiberStatus::Failed;
    fiber.current = None;
    let event = Event::Failed { fiber_id: fiber.id, error_ref };
    fiber.last_event = Some(event.clone());
    event
}
