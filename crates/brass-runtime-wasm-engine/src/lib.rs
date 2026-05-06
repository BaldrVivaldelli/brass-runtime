use js_sys::{Array, Uint32Array};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use wasm_bindgen::prelude::*;

type FiberId = u32;
type NodeId = u32;
type RefId = u32;
type LaneId = u32;

type TimerId = u32;
type PermitId = u32;
type RetryId = u32;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonProgram {
    pub version: u32,
    pub root: NodeId,
    pub nodes: Vec<OpcodeNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "PascalCase",
    rename_all_fields = "camelCase"
)]
pub enum OpcodeNode {
    Succeed {
        value_ref: RefId,
    },
    Fail {
        error_ref: RefId,
    },
    Sync {
        fn_ref: RefId,
    },
    Async {
        register_ref: RefId,
    },
    FlatMap {
        first: NodeId,
        fn_ref: RefId,
    },
    Fold {
        first: NodeId,
        on_failure_ref: RefId,
        on_success_ref: RefId,
    },
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
struct Program {
    root: NodeId,
    nodes: Vec<Node>,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Node {
    tag: u32,
    a: u32,
    b: u32,
    c: u32,
}

impl Node {
    const fn new(tag: u32, a: u32, b: u32, c: u32) -> Node {
        Node { tag, a, b, c }
    }
}

impl From<OpcodeNode> for Node {
    fn from(node: OpcodeNode) -> Node {
        match node {
            OpcodeNode::Succeed { value_ref } => Node::new(OP_SUCCEED, value_ref, 0, 0),
            OpcodeNode::Fail { error_ref } => Node::new(OP_FAIL, error_ref, 0, 0),
            OpcodeNode::Sync { fn_ref } => Node::new(OP_SYNC, fn_ref, 0, 0),
            OpcodeNode::Async { register_ref } => Node::new(OP_ASYNC, register_ref, 0, 0),
            OpcodeNode::FlatMap { first, fn_ref } => Node::new(OP_FLAT_MAP, first, fn_ref, 0),
            OpcodeNode::Fold {
                first,
                on_failure_ref,
                on_success_ref,
            } => Node::new(OP_FOLD, first, on_failure_ref, on_success_ref),
            OpcodeNode::Fork {
                effect_ref,
                scope_id,
            } => Node::new(OP_FORK, effect_ref, scope_id.unwrap_or(NONE_U32), 0),
            OpcodeNode::HostAction {
                action_ref,
                decode_ref,
            } => Node::new(
                OP_HOST_ACTION,
                action_ref,
                decode_ref.unwrap_or(NONE_U32),
                0,
            ),
        }
    }
}

fn json_program_to_program(json: JsonProgram) -> Program {
    Program {
        root: json.root,
        nodes: json.nodes.into_iter().map(Node::from).collect(),
    }
}

#[derive(Debug, Clone)]
enum Frame {
    SuccessCont {
        fn_ref: RefId,
    },
    FoldCont {
        on_failure_ref: RefId,
        on_success_ref: RefId,
    },
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
#[serde(
    tag = "kind",
    rename_all = "PascalCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Continue {
        fiber_id: FiberId,
    },
    Done {
        fiber_id: FiberId,
        value_ref: RefId,
    },
    Failed {
        fiber_id: FiberId,
        error_ref: RefId,
    },
    Interrupted {
        fiber_id: FiberId,
        reason_ref: RefId,
    },
    InvokeSync {
        fiber_id: FiberId,
        fn_ref: RefId,
    },
    InvokeAsync {
        fiber_id: FiberId,
        register_ref: RefId,
    },
    InvokeFlatMap {
        fiber_id: FiberId,
        fn_ref: RefId,
        value_ref: RefId,
    },
    InvokeFoldFailure {
        fiber_id: FiberId,
        fn_ref: RefId,
        error_ref: RefId,
    },
    InvokeFoldSuccess {
        fiber_id: FiberId,
        fn_ref: RefId,
        value_ref: RefId,
    },
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

const ABI_VERSION: u32 = 1;
const NONE_U32: u32 = u32::MAX;
const EVENT_WORDS: usize = 5;

const OP_SUCCEED: u32 = 0;
const OP_FAIL: u32 = 1;
const OP_SYNC: u32 = 2;
const OP_ASYNC: u32 = 3;
const OP_FLAT_MAP: u32 = 4;
const OP_FOLD: u32 = 5;
const OP_FORK: u32 = 6;
const OP_HOST_ACTION: u32 = 7;

const EV_CONTINUE: u32 = 0;
const EV_DONE: u32 = 1;
const EV_FAILED: u32 = 2;
const EV_INTERRUPTED: u32 = 3;
const EV_INVOKE_SYNC: u32 = 4;
const EV_INVOKE_ASYNC: u32 = 5;
const EV_INVOKE_FLAT_MAP: u32 = 6;
const EV_INVOKE_FOLD_FAILURE: u32 = 7;
const EV_INVOKE_FOLD_SUCCESS: u32 = 8;
const EV_INVOKE_FORK: u32 = 9;
const EV_INVOKE_HOST_ACTION: u32 = 10;

fn decode_program_words(words: &[u32]) -> Result<Program, String> {
    if words.len() < 3 {
        return Err(String::from(
            "binary program must contain version, root and node count",
        ));
    }
    if words[0] != ABI_VERSION {
        return Err(format!(
            "unsupported binary program ABI version {}",
            words[0]
        ));
    }
    let root = words[1];
    let count = words[2] as usize;
    let nodes = decode_nodes_body(&words[3..], count)?;
    Ok(Program { root, nodes })
}

fn decode_patch_nodes_words(words: &[u32]) -> Result<Vec<Node>, String> {
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let count = words[0] as usize;
    decode_nodes_body(&words[1..], count)
}

fn decode_nodes_body(words: &[u32], count: usize) -> Result<Vec<Node>, String> {
    let expected = count
        .checked_mul(4)
        .ok_or_else(|| String::from("node count overflow"))?;
    if words.len() < expected {
        return Err(format!(
            "binary node buffer too short: expected {}, got {}",
            expected,
            words.len()
        ));
    }
    let mut nodes = Vec::with_capacity(count);
    for idx in 0..count {
        let base = idx * 4;
        let tag = words[base];
        let a = words[base + 1];
        let b = words[base + 2];
        let c = words[base + 3];
        match tag {
            OP_SUCCEED | OP_FAIL | OP_SYNC | OP_ASYNC | OP_FLAT_MAP | OP_FOLD | OP_FORK
            | OP_HOST_ACTION => {
                nodes.push(Node::new(tag, a, b, c));
            }
            _ => return Err(format!("unknown binary opcode tag {} at node {}", tag, idx)),
        }
    }
    Ok(nodes)
}

fn encode_event_words(event: &Event) -> [u32; EVENT_WORDS] {
    match event {
        Event::Continue { fiber_id } => [EV_CONTINUE, *fiber_id, 0, 0, 0],
        Event::Done {
            fiber_id,
            value_ref,
        } => [EV_DONE, *fiber_id, *value_ref, 0, 0],
        Event::Failed {
            fiber_id,
            error_ref,
        } => [EV_FAILED, *fiber_id, *error_ref, 0, 0],
        Event::Interrupted {
            fiber_id,
            reason_ref,
        } => [EV_INTERRUPTED, *fiber_id, *reason_ref, 0, 0],
        Event::InvokeSync { fiber_id, fn_ref } => [EV_INVOKE_SYNC, *fiber_id, *fn_ref, 0, 0],
        Event::InvokeAsync {
            fiber_id,
            register_ref,
        } => [EV_INVOKE_ASYNC, *fiber_id, *register_ref, 0, 0],
        Event::InvokeFlatMap {
            fiber_id,
            fn_ref,
            value_ref,
        } => [EV_INVOKE_FLAT_MAP, *fiber_id, *fn_ref, *value_ref, 0],
        Event::InvokeFoldFailure {
            fiber_id,
            fn_ref,
            error_ref,
        } => [EV_INVOKE_FOLD_FAILURE, *fiber_id, *fn_ref, *error_ref, 0],
        Event::InvokeFoldSuccess {
            fiber_id,
            fn_ref,
            value_ref,
        } => [EV_INVOKE_FOLD_SUCCESS, *fiber_id, *fn_ref, *value_ref, 0],
        Event::InvokeFork {
            fiber_id,
            effect_ref,
            scope_id,
        } => [
            EV_INVOKE_FORK,
            *fiber_id,
            *effect_ref,
            scope_id.unwrap_or(NONE_U32),
            0,
        ],
        Event::InvokeHostAction {
            fiber_id,
            action_ref,
            decode_ref,
        } => [
            EV_INVOKE_HOST_ACTION,
            *fiber_id,
            *action_ref,
            decode_ref.unwrap_or(NONE_U32),
            0,
        ],
    }
}

fn event_batch_to_array(words: &[u32]) -> Uint32Array {
    let out = Uint32Array::new_with_length(words.len() as u32);
    for (idx, word) in words.iter().enumerate() {
        out.set_index(idx as u32, *word);
    }
    out
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
    boundary_calls: u64,
    batches_emitted: u64,
    events_emitted: u64,
    events_per_boundary_call: f64,
    max_events_per_boundary_call: u32,
    binary_programs: u64,
    json_programs: u64,
    binary_patches: u64,
    json_patches: u64,
    zero_copy_programs: u64,
    zero_copy_patches: u64,
    zero_copy_event_batches: u64,
    fiber_slab_live: usize,
    fiber_slab_capacity: usize,
    fiber_slab_reused: u64,
    fiber_slab_released: u64,
    fiber_slab_stale_reads: u64,
}

const VM_METRIC_STARTED: u32 = 0;
const VM_METRIC_LIVE: u32 = 1;
const VM_METRIC_RUNNING: u32 = 2;
const VM_METRIC_SUSPENDED: u32 = 3;
const VM_METRIC_COMPLETED: u32 = 4;
const VM_METRIC_FAILED: u32 = 5;
const VM_METRIC_INTERRUPTED: u32 = 6;
const VM_METRIC_BOUNDARY_CALLS: u32 = 7;
const VM_METRIC_BATCHES_EMITTED: u32 = 8;
const VM_METRIC_EVENTS_EMITTED: u32 = 9;
const VM_METRIC_EVENTS_PER_BOUNDARY_CALL: u32 = 10;
const VM_METRIC_MAX_EVENTS_PER_BOUNDARY_CALL: u32 = 11;
const VM_METRIC_BINARY_PROGRAMS: u32 = 12;
const VM_METRIC_JSON_PROGRAMS: u32 = 13;
const VM_METRIC_BINARY_PATCHES: u32 = 14;
const VM_METRIC_JSON_PATCHES: u32 = 15;
const VM_METRIC_ZERO_COPY_PROGRAMS: u32 = 16;
const VM_METRIC_ZERO_COPY_PATCHES: u32 = 17;
const VM_METRIC_ZERO_COPY_EVENT_BATCHES: u32 = 18;
const VM_METRIC_FIBER_SLAB_LIVE: u32 = 19;
const VM_METRIC_FIBER_SLAB_CAPACITY: u32 = 20;
const VM_METRIC_FIBER_SLAB_REUSED: u32 = 21;
const VM_METRIC_FIBER_SLAB_RELEASED: u32 = 22;
const VM_METRIC_FIBER_SLAB_STALE_READS: u32 = 23;
const VM_METRIC_COUNT: usize = 24;

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
        })
        .expect("chunk buffer stats json")
    }
}

const SCHEDULER_POLICY_MICRO: u32 = 0;
const SCHEDULER_POLICY_MACRO: u32 = 1;
const SCHEDULER_POLICY_NONE: u32 = 2;
const SCHEDULER_POLICY_DROPPED: u32 = 3;

const DEFAULT_LANE_CAPACITY: usize = 1024;
const DEFAULT_LANE_BUDGET: usize = 64;
const DEFAULT_MAX_LANES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchedulerPhase {
    Idle,
    ScheduledMicro,
    ScheduledMacro,
    Flushing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaneStats {
    id: LaneId,
    key: String,
    len: usize,
    capacity: usize,
    enqueued_tasks: u64,
    executed_tasks: u64,
    dropped_tasks: u64,
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
    lane_intern_hits: u64,
    lane_intern_misses: u64,
    lanes: Vec<LaneStats>,
}

#[derive(Debug, Clone)]
struct LaneState {
    id: LaneId,
    key: String,
    queue: Vec<u32>,
    head: usize,
    tail: usize,
    len: usize,
    enqueued_tasks: u64,
    executed_tasks: u64,
    dropped_tasks: u64,
}

impl LaneState {
    fn new(id: LaneId, key: String, capacity: usize) -> LaneState {
        let cap = next_pow2(capacity.max(2));
        LaneState {
            id,
            key,
            queue: vec![0; cap],
            head: 0,
            tail: 0,
            len: 0,
            enqueued_tasks: 0,
            executed_tasks: 0,
            dropped_tasks: 0,
        }
    }

    fn capacity(&self) -> usize {
        self.queue.len()
    }

    fn push(&mut self, task_ref: u32) -> bool {
        if self.len == self.queue.len() {
            return false;
        }
        self.queue[self.tail] = task_ref;
        self.tail = (self.tail + 1) & (self.queue.len() - 1);
        self.len += 1;
        true
    }

    fn shift(&mut self) -> Option<u32> {
        if self.len == 0 {
            return None;
        }
        let task_ref = self.queue[self.head];
        self.queue[self.head] = 0;
        self.head = (self.head + 1) & (self.queue.len() - 1);
        self.len -= 1;
        Some(task_ref)
    }

    fn clear(&mut self) {
        self.queue.fill(0);
        self.head = 0;
        self.tail = 0;
        self.len = 0;
    }

    fn stats(&self) -> LaneStats {
        LaneStats {
            id: self.id,
            key: self.key.clone(),
            len: self.len,
            capacity: self.capacity(),
            enqueued_tasks: self.enqueued_tasks,
            executed_tasks: self.executed_tasks,
            dropped_tasks: self.dropped_tasks,
        }
    }
}

#[wasm_bindgen]
pub struct BrassWasmSchedulerStateMachine {
    lanes: Vec<LaneState>,
    lane_index: HashMap<String, LaneId>,
    rr_index: usize,
    rr_remaining: usize,
    total_len: usize,
    phase: SchedulerPhase,
    flush_budget: usize,
    micro_threshold: usize,
    lane_capacity: usize,
    lane_budget: usize,
    max_lanes: usize,
    scheduled_flushes: u64,
    completed_flushes: u64,
    enqueued_tasks: u64,
    executed_tasks: u64,
    dropped_tasks: u64,
    yielded_by_budget: u64,
    lane_intern_hits: u64,
    lane_intern_misses: u64,
}

#[wasm_bindgen]
impl BrassWasmSchedulerStateMachine {
    #[wasm_bindgen(constructor)]
    pub fn new(
        _initial_capacity: usize,
        max_capacity: usize,
        flush_budget: usize,
        micro_threshold: usize,
        lane_capacity: usize,
        lane_budget: usize,
        max_lanes: usize,
    ) -> BrassWasmSchedulerStateMachine {
        BrassWasmSchedulerStateMachine {
            lanes: Vec::new(),
            lane_index: HashMap::new(),
            rr_index: 0,
            rr_remaining: 0,
            total_len: 0,
            phase: SchedulerPhase::Idle,
            flush_budget: flush_budget.max(1),
            micro_threshold: micro_threshold.max(1),
            lane_capacity: if lane_capacity == 0 {
                max_capacity.max(DEFAULT_LANE_CAPACITY)
            } else {
                lane_capacity
            },
            lane_budget: if lane_budget == 0 {
                DEFAULT_LANE_BUDGET
            } else {
                lane_budget
            },
            max_lanes: if max_lanes == 0 {
                DEFAULT_MAX_LANES
            } else {
                max_lanes
            },
            scheduled_flushes: 0,
            completed_flushes: 0,
            enqueued_tasks: 0,
            executed_tasks: 0,
            dropped_tasks: 0,
            yielded_by_budget: 0,
            lane_intern_hits: 0,
            lane_intern_misses: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.total_len
    }
    pub fn capacity(&self) -> usize {
        self.lanes.iter().map(LaneState::capacity).sum()
    }
    pub fn is_flushing(&self) -> bool {
        self.phase == SchedulerPhase::Flushing
    }
    pub fn is_scheduled(&self) -> bool {
        matches!(
            self.phase,
            SchedulerPhase::ScheduledMicro | SchedulerPhase::ScheduledMacro
        )
    }

    pub fn intern_lane(&mut self, key: &str) -> LaneId {
        let lane_key = sanitize_lane_key(key);
        if let Some(id) = self.lane_index.get(&lane_key) {
            self.lane_intern_hits += 1;
            return *id;
        }
        self.lane_intern_misses += 1;
        self.get_or_create_lane_id(&lane_key)
    }

    pub fn enqueue(&mut self, task_ref: u32, tag: &str) -> u32 {
        let lane_key = infer_lane(tag);
        let lane_id = self.intern_lane(&lane_key);
        self.enqueue_lane(task_ref, lane_id)
    }

    pub fn enqueue_lane(&mut self, task_ref: u32, lane_id: LaneId) -> u32 {
        let lane_idx = self.lane_idx_or_overflow(lane_id);
        self.enqueued_tasks += 1;
        let accepted = {
            let lane = &mut self.lanes[lane_idx];
            lane.enqueued_tasks += 1;
            let accepted = lane.push(task_ref);
            if !accepted {
                lane.dropped_tasks += 1;
            }
            accepted
        };
        if !accepted {
            self.dropped_tasks += 1;
            return SCHEDULER_POLICY_DROPPED;
        }
        self.total_len += 1;
        if self.phase != SchedulerPhase::Idle {
            return SCHEDULER_POLICY_NONE;
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

    pub fn begin_flush(&mut self) -> usize {
        if self.phase == SchedulerPhase::Flushing {
            return 0;
        }
        if self.total_len == 0 {
            self.phase = SchedulerPhase::Idle;
            return 0;
        }
        self.phase = SchedulerPhase::Flushing;
        self.flush_budget.min(self.total_len)
    }

    pub fn shift(&mut self) -> u32 {
        let (lane_idx, task_ref) = match self.shift_from_next_lane() {
            Some(next) => next,
            None => return 0,
        };
        self.total_len -= 1;
        self.executed_tasks += 1;
        self.lanes[lane_idx].executed_tasks += 1;
        task_ref
    }

    pub fn end_flush(&mut self, ran: usize) -> u32 {
        self.completed_flushes += 1;
        if self.total_len == 0 {
            self.phase = SchedulerPhase::Idle;
            return SCHEDULER_POLICY_NONE;
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
        for lane in &mut self.lanes {
            lane.clear();
        }
        self.rr_index = 0;
        self.rr_remaining = 0;
        self.total_len = 0;
        self.phase = SchedulerPhase::Idle;
    }

    pub fn lane_len(&self, lane_id: LaneId) -> usize {
        self.lane_id_to_idx(lane_id)
            .and_then(|idx| self.lanes.get(idx))
            .map(|lane| lane.len)
            .unwrap_or(0)
    }

    pub fn metric_u64(&self, id: u32) -> f64 {
        match id {
            0 => self.total_len as f64,
            1 => self.enqueued_tasks as f64,
            2 => self.executed_tasks as f64,
            3 => self.dropped_tasks as f64,
            4 => self.yielded_by_budget as f64,
            5 => self.lane_intern_hits as f64,
            6 => self.lane_intern_misses as f64,
            7 => self.lanes.len() as f64,
            _ => 0.0,
        }
    }

    pub fn stats_json(&self) -> String {
        serde_json::to_string(&SchedulerStats {
            phase: match self.phase {
                SchedulerPhase::Idle => "idle",
                SchedulerPhase::ScheduledMicro => "scheduledMicro",
                SchedulerPhase::ScheduledMacro => "scheduledMacro",
                SchedulerPhase::Flushing => "flushing",
            },
            len: self.total_len,
            capacity: self.capacity(),
            scheduled_flushes: self.scheduled_flushes,
            completed_flushes: self.completed_flushes,
            enqueued_tasks: self.enqueued_tasks,
            executed_tasks: self.executed_tasks,
            dropped_tasks: self.dropped_tasks,
            yielded_by_budget: self.yielded_by_budget,
            lane_intern_hits: self.lane_intern_hits,
            lane_intern_misses: self.lane_intern_misses,
            lanes: self.lanes.iter().map(LaneState::stats).collect(),
        })
        .expect("scheduler stats json")
    }

    fn next_policy(&self) -> u32 {
        if self.total_len > self.micro_threshold {
            SCHEDULER_POLICY_MACRO
        } else {
            SCHEDULER_POLICY_MICRO
        }
    }

    fn lane_id_to_idx(&self, lane_id: LaneId) -> Option<usize> {
        if lane_id == 0 {
            return None;
        }
        let idx = (lane_id - 1) as usize;
        if idx < self.lanes.len() {
            Some(idx)
        } else {
            None
        }
    }

    fn lane_idx_or_overflow(&mut self, lane_id: LaneId) -> usize {
        if let Some(idx) = self.lane_id_to_idx(lane_id) {
            return idx;
        }
        let overflow_id = self.get_or_create_lane_id("overflow");
        self.lane_id_to_idx(overflow_id).unwrap_or(0)
    }

    fn get_or_create_lane_id(&mut self, requested_key: &str) -> LaneId {
        if let Some(id) = self.lane_index.get(requested_key) {
            return *id;
        }
        let key = if self.lane_index.len() >= self.max_lanes {
            String::from("overflow")
        } else {
            requested_key.to_owned()
        };
        if let Some(id) = self.lane_index.get(&key) {
            return *id;
        }
        let id = (self.lanes.len() as LaneId).saturating_add(1);
        self.lanes
            .push(LaneState::new(id, key.clone(), self.lane_capacity));
        self.lane_index.insert(key, id);
        id
    }

    fn shift_from_next_lane(&mut self) -> Option<(usize, u32)> {
        let n = self.lanes.len();
        if n == 0 {
            return None;
        }
        if self.rr_remaining > 0 {
            let current_idx = (self.rr_index + n - 1) % n;
            if let Some(task_ref) = self.lanes[current_idx].shift() {
                self.rr_remaining -= 1;
                return Some((current_idx, task_ref));
            }
            self.rr_remaining = 0;
        }
        for _ in 0..n {
            let idx = self.rr_index % n;
            self.rr_index = (idx + 1) % n;
            if self.lanes[idx].len == 0 {
                continue;
            }
            self.rr_remaining = self.lane_budget.saturating_sub(1);
            if let Some(task_ref) = self.lanes[idx].shift() {
                return Some((idx, task_ref));
            }
        }
        None
    }
}

#[wasm_bindgen]
pub struct BrassWasmFiberReadyQueue {
    inner: BrassWasmSchedulerStateMachine,
}

#[wasm_bindgen]
impl BrassWasmFiberReadyQueue {
    #[wasm_bindgen(constructor)]
    pub fn new(
        flush_budget: usize,
        micro_threshold: usize,
        lane_capacity: usize,
        lane_budget: usize,
        max_lanes: usize,
    ) -> BrassWasmFiberReadyQueue {
        BrassWasmFiberReadyQueue {
            inner: BrassWasmSchedulerStateMachine::new(
                lane_capacity.max(2),
                lane_capacity.max(2),
                flush_budget,
                micro_threshold,
                lane_capacity,
                lane_budget,
                max_lanes,
            ),
        }
    }

    pub fn intern_lane(&mut self, key: &str) -> LaneId {
        self.inner.intern_lane(key)
    }
    pub fn enqueue_fiber(&mut self, fiber_id: FiberId, tag: &str) -> u32 {
        self.inner.enqueue(fiber_id, tag)
    }
    pub fn enqueue_fiber_lane(&mut self, fiber_id: FiberId, lane_id: LaneId) -> u32 {
        self.inner.enqueue_lane(fiber_id, lane_id)
    }
    pub fn begin_flush(&mut self) -> usize {
        self.inner.begin_flush()
    }
    pub fn shift_fiber(&mut self) -> FiberId {
        self.inner.shift()
    }
    pub fn end_flush(&mut self, ran: usize) -> u32 {
        self.inner.end_flush(ran)
    }
    pub fn len(&self) -> usize {
        self.inner.len()
    }
    pub fn clear(&mut self) {
        self.inner.clear();
    }
    pub fn metric_u64(&self, id: u32) -> f64 {
        self.inner.metric_u64(id)
    }
    pub fn stats_json(&self) -> String {
        self.inner.stats_json()
    }
}

fn sanitize_lane_key(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_ws = false;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            if !last_was_ws && !out.is_empty() {
                out.push(':');
            }
            last_was_ws = true;
            continue;
        }
        last_was_ws = false;
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '#' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
        if out.len() >= 160 {
            break;
        }
    }
    if out.is_empty() {
        String::from("anonymous")
    } else {
        out
    }
}

fn infer_lane(tag: &str) -> String {
    if let Some(rest) = tag.strip_prefix("lane:") {
        if let Some(end) = rest.find('|') {
            let explicit = &rest[..end];
            if !explicit.is_empty() {
                return sanitize_lane_key(explicit);
            }
        }
    }
    if let Some(rest) = tag.strip_prefix("caller:") {
        if let Some(end) = rest.find('|') {
            let caller = &rest[..end];
            if !caller.is_empty() {
                return sanitize_lane_key(caller);
            }
        }
    }
    let first = tag
        .split(|ch| ch == '.' || ch == '#' || ch == '/')
        .next()
        .unwrap_or(tag);
    sanitize_lane_key(first)
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

    pub fn register_fiber(
        &mut self,
        fiber_id: FiberId,
        parent_id: u32,
        scope_id: u32,
        now_ms: f64,
    ) -> bool {
        let existed = self.entries.contains_key(&fiber_id);
        self.entries.insert(
            fiber_id,
            FiberRegistryEntry {
                state: FIBER_STATE_RUNNING,
                parent_id,
                scope_id,
                created_at_ms: now_ms,
                last_active_at_ms: now_ms,
                joiners: 0,
                wakeups: 0,
            },
        );
        if !existed {
            self.registered += 1;
        }
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
                if entry.state < FIBER_STATE_DONE {
                    self.completed += 1;
                }
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
                if entry.wakeups > 0 {
                    entry.wakeups -= 1;
                }
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
        self.entries
            .get(&fiber_id)
            .map(|e| e.state)
            .unwrap_or(u32::MAX)
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
        })
        .expect("fiber registry stats json")
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

const FIBER_INDEX_BITS: u32 = 20;
const FIBER_INDEX_MASK: u32 = (1 << FIBER_INDEX_BITS) - 1;
const FIBER_GENERATION_SHIFT: u32 = FIBER_INDEX_BITS;
const FIBER_GENERATION_MASK: u32 = (1 << (32 - FIBER_INDEX_BITS)) - 1;

fn encode_fiber_id(index: u32, generation: u32) -> FiberId {
    (((generation & FIBER_GENERATION_MASK) << FIBER_GENERATION_SHIFT) | (index & FIBER_INDEX_MASK))
        as FiberId
}

fn decode_fiber_id(fiber_id: FiberId) -> (usize, u32) {
    (
        (fiber_id & FIBER_INDEX_MASK) as usize,
        (fiber_id >> FIBER_GENERATION_SHIFT) & FIBER_GENERATION_MASK,
    )
}

struct FiberSlot {
    generation: u32,
    vm: Option<FiberVm>,
}

struct FiberSlab {
    slots: Vec<FiberSlot>,
    free: Vec<usize>,
    live: usize,
    allocated: u64,
    reused: u64,
    released: u64,
    stale_reads: u64,
}

impl FiberSlab {
    fn new() -> FiberSlab {
        FiberSlab {
            slots: vec![FiberSlot {
                generation: 0,
                vm: None,
            }],
            free: Vec::new(),
            live: 0,
            allocated: 0,
            reused: 0,
            released: 0,
            stale_reads: 0,
        }
    }

    fn insert(&mut self, mut vm: FiberVm) -> FiberId {
        let index = self.free.pop().unwrap_or(self.slots.len());
        if index == self.slots.len() {
            self.slots.push(FiberSlot {
                generation: 0,
                vm: None,
            });
        } else {
            self.reused += 1;
        }
        let slot = &mut self.slots[index];
        slot.generation = ((slot.generation + 1) & FIBER_GENERATION_MASK).max(1);
        let id = encode_fiber_id(index as u32, slot.generation);
        vm.id = id;
        slot.vm = Some(vm);
        self.live += 1;
        self.allocated += 1;
        id
    }

    fn get_mut(&mut self, fiber_id: FiberId) -> Option<&mut FiberVm> {
        let (index, generation) = decode_fiber_id(fiber_id);
        if index >= self.slots.len() {
            self.stale_reads += 1;
            return None;
        }
        let is_stale = {
            let slot = &self.slots[index];
            slot.generation != generation || slot.vm.is_none()
        };
        if is_stale {
            self.stale_reads += 1;
            return None;
        }
        self.slots[index].vm.as_mut()
    }

    fn remove(&mut self, fiber_id: FiberId) -> bool {
        let (index, generation) = decode_fiber_id(fiber_id);
        let Some(slot) = self.slots.get_mut(index) else {
            self.stale_reads += 1;
            return false;
        };
        if slot.generation != generation || slot.vm.is_none() {
            self.stale_reads += 1;
            return false;
        }
        slot.vm = None;
        self.live = self.live.saturating_sub(1);
        self.released += 1;
        self.free.push(index);
        true
    }

    fn iter(&self) -> impl Iterator<Item = &FiberVm> {
        self.slots.iter().filter_map(|slot| slot.vm.as_ref())
    }

    fn len(&self) -> usize {
        self.live
    }
    fn capacity(&self) -> usize {
        self.slots.len().saturating_sub(1)
    }
}

#[wasm_bindgen]
pub struct BrassWasmVm {
    fibers: FiberSlab,
    event_scratch: Vec<u32>,
    program_scratch: Vec<u32>,
    metrics_scratch: Vec<f64>,
    started: u64,
    completed: u64,
    failed: u64,
    interrupted: u64,
    boundary_calls: u64,
    batches_emitted: u64,
    events_emitted: u64,
    max_events_per_boundary_call: u32,
    binary_programs: u64,
    json_programs: u64,
    binary_patches: u64,
    json_patches: u64,
    zero_copy_programs: u64,
    zero_copy_patches: u64,
    zero_copy_event_batches: u64,
}

#[wasm_bindgen]
impl BrassWasmVm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BrassWasmVm {
        BrassWasmVm {
            fibers: FiberSlab::new(),
            event_scratch: Vec::with_capacity(1 + EVENT_WORDS * 64),
            program_scratch: Vec::new(),
            metrics_scratch: Vec::with_capacity(VM_METRIC_COUNT),
            started: 0,
            completed: 0,
            failed: 0,
            interrupted: 0,
            boundary_calls: 0,
            batches_emitted: 0,
            events_emitted: 0,
            max_events_per_boundary_call: 0,
            binary_programs: 0,
            json_programs: 0,
            binary_patches: 0,
            json_patches: 0,
            zero_copy_programs: 0,
            zero_copy_patches: 0,
            zero_copy_event_batches: 0,
        }
    }

    pub fn memory(&self) -> JsValue {
        wasm_bindgen::memory()
    }

    pub fn prepare_program_words(&mut self, word_len: usize) -> u32 {
        self.program_scratch.clear();
        self.program_scratch.resize(word_len, 0);
        self.program_scratch.as_mut_ptr() as u32
    }

    pub fn prepare_patch_words(&mut self, word_len: usize) -> u32 {
        self.prepare_program_words(word_len)
    }

    pub fn create_fiber_from_program_words(&mut self, word_len: usize) -> FiberId {
        let len = word_len.min(self.program_scratch.len());
        let program = decode_program_words(&self.program_scratch[..len])
            .unwrap_or_else(|err| panic!("invalid zero-copy brass program: {}", err));
        self.zero_copy_programs += 1;
        self.insert_program(program)
    }

    pub fn create_fiber(&mut self, program_json: &str) -> FiberId {
        let program_json: JsonProgram = serde_json::from_str(program_json)
            .unwrap_or_else(|err| panic!("invalid brass program: {}", err));
        self.json_programs += 1;
        self.insert_program(json_program_to_program(program_json))
    }

    pub fn create_fiber_bin(&mut self, program_words: &[u32]) -> FiberId {
        let program = decode_program_words(program_words)
            .unwrap_or_else(|err| panic!("invalid binary brass program: {}", err));
        self.binary_programs += 1;
        self.insert_program(program)
    }

    fn insert_program(&mut self, program: Program) -> FiberId {
        self.started += 1;
        self.fibers.insert(FiberVm {
            id: 0,
            current: Some(program.root),
            program,
            stack: Vec::new(),
            status: FiberStatus::Running,
            last_event: None,
        })
    }

    pub fn poll(&mut self, fiber_id: FiberId) -> String {
        let event = self.poll_event(fiber_id);
        self.account_event(&event);
        self.account_boundary(1);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn drive_batch_ptr(&mut self, fiber_id: FiberId, budget: u32) -> u32 {
        self.drive_sequence_to_scratch(fiber_id, None, budget.max(1));
        self.zero_copy_event_batches += 1;
        self.event_scratch.as_ptr() as u32
    }

    pub fn event_batch_len(&self) -> usize {
        self.event_scratch.len()
    }

    pub fn drive_batch_bin(&mut self, fiber_id: FiberId, budget: u32) -> Uint32Array {
        self.drive_sequence_to_scratch(fiber_id, None, budget.max(1));
        event_batch_to_array(&self.event_scratch)
    }

    pub fn poll_bin(&mut self, fiber_id: FiberId) -> Uint32Array {
        self.drive_batch_bin(fiber_id, 1)
    }

    pub fn provide_value(&mut self, fiber_id: FiberId, value_ref: RefId) -> String {
        let event = self.provide_value_event(fiber_id, value_ref);
        self.account_event(&event);
        self.account_boundary(1);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_value_ptr(&mut self, fiber_id: FiberId, value_ref: RefId, budget: u32) -> u32 {
        let event = self.provide_value_event(fiber_id, value_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        self.zero_copy_event_batches += 1;
        self.event_scratch.as_ptr() as u32
    }

    pub fn provide_value_bin(
        &mut self,
        fiber_id: FiberId,
        value_ref: RefId,
        budget: u32,
    ) -> Uint32Array {
        let event = self.provide_value_event(fiber_id, value_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        event_batch_to_array(&self.event_scratch)
    }

    pub fn provide_error(&mut self, fiber_id: FiberId, error_ref: RefId) -> String {
        let event = self.provide_error_event(fiber_id, error_ref);
        self.account_event(&event);
        self.account_boundary(1);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_error_ptr(&mut self, fiber_id: FiberId, error_ref: RefId, budget: u32) -> u32 {
        let event = self.provide_error_event(fiber_id, error_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        self.zero_copy_event_batches += 1;
        self.event_scratch.as_ptr() as u32
    }

    pub fn provide_error_bin(
        &mut self,
        fiber_id: FiberId,
        error_ref: RefId,
        budget: u32,
    ) -> Uint32Array {
        let event = self.provide_error_event(fiber_id, error_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        event_batch_to_array(&self.event_scratch)
    }

    pub fn provide_effect(&mut self, fiber_id: FiberId, root: NodeId, nodes_json: &str) -> String {
        self.json_patches += 1;
        let json_nodes: Vec<OpcodeNode> = serde_json::from_str(nodes_json)
            .unwrap_or_else(|err| panic!("invalid brass nodes: {}", err));
        let nodes = json_nodes.into_iter().map(Node::from).collect();
        let event = self.provide_effect_event(fiber_id, root, nodes);
        self.account_event(&event);
        self.account_boundary(1);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn provide_effect_from_words(
        &mut self,
        fiber_id: FiberId,
        root: NodeId,
        word_len: usize,
        budget: u32,
    ) -> u32 {
        let len = word_len.min(self.program_scratch.len());
        let nodes = decode_patch_nodes_words(&self.program_scratch[..len])
            .unwrap_or_else(|err| panic!("invalid zero-copy brass patch: {}", err));
        self.zero_copy_patches += 1;
        let event = self.provide_effect_event(fiber_id, root, nodes);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        self.zero_copy_event_batches += 1;
        self.event_scratch.as_ptr() as u32
    }

    pub fn provide_effect_bin(
        &mut self,
        fiber_id: FiberId,
        root: NodeId,
        nodes_words: &[u32],
        budget: u32,
    ) -> Uint32Array {
        let nodes = decode_patch_nodes_words(nodes_words)
            .unwrap_or_else(|err| panic!("invalid binary brass patch: {}", err));
        self.binary_patches += 1;
        let event = self.provide_effect_event(fiber_id, root, nodes);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        event_batch_to_array(&self.event_scratch)
    }

    pub fn interrupt(&mut self, fiber_id: FiberId, reason_ref: RefId) -> String {
        let event = self.interrupt_event(fiber_id, reason_ref);
        self.account_event(&event);
        self.account_boundary(1);
        serde_json::to_string(&event).expect("event json")
    }

    pub fn interrupt_ptr(&mut self, fiber_id: FiberId, reason_ref: RefId, budget: u32) -> u32 {
        let event = self.interrupt_event(fiber_id, reason_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        self.zero_copy_event_batches += 1;
        self.event_scratch.as_ptr() as u32
    }

    pub fn interrupt_bin(
        &mut self,
        fiber_id: FiberId,
        reason_ref: RefId,
        budget: u32,
    ) -> Uint32Array {
        let event = self.interrupt_event(fiber_id, reason_ref);
        self.drive_sequence_to_scratch(fiber_id, Some(event), budget.max(1));
        event_batch_to_array(&self.event_scratch)
    }

    pub fn drop_fiber(&mut self, fiber_id: FiberId) {
        self.fibers.remove(fiber_id);
    }

    fn poll_event(&mut self, fiber_id: FiberId) -> Event {
        match self.fibers.get_mut(fiber_id) {
            Some(fiber) => {
                if fiber.status == FiberStatus::Suspended {
                    fiber
                        .last_event
                        .clone()
                        .unwrap_or(Event::Continue { fiber_id })
                } else {
                    step_fiber(fiber)
                }
            }
            None => Event::Failed {
                fiber_id,
                error_ref: 0,
            },
        }
    }

    fn provide_value_event(&mut self, fiber_id: FiberId, value_ref: RefId) -> Event {
        match self.fibers.get_mut(fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                success(fiber, value_ref)
            }
            None => Event::Failed {
                fiber_id,
                error_ref: 0,
            },
        }
    }

    fn provide_error_event(&mut self, fiber_id: FiberId, error_ref: RefId) -> Event {
        match self.fibers.get_mut(fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                failure(fiber, error_ref)
            }
            None => Event::Failed {
                fiber_id,
                error_ref: 0,
            },
        }
    }

    fn provide_effect_event(&mut self, fiber_id: FiberId, root: NodeId, nodes: Vec<Node>) -> Event {
        match self.fibers.get_mut(fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Running;
                fiber.last_event = None;
                fiber.program.nodes.extend(nodes);
                fiber.current = Some(root);
                step_fiber(fiber)
            }
            None => Event::Failed {
                fiber_id,
                error_ref: 0,
            },
        }
    }

    fn interrupt_event(&mut self, fiber_id: FiberId, reason_ref: RefId) -> Event {
        match self.fibers.get_mut(fiber_id) {
            Some(fiber) => {
                fiber.status = FiberStatus::Interrupted;
                fiber.current = None;
                fiber.stack.clear();
                let event = Event::Interrupted {
                    fiber_id,
                    reason_ref,
                };
                fiber.last_event = Some(event.clone());
                event
            }
            None => Event::Interrupted {
                fiber_id,
                reason_ref,
            },
        }
    }

    fn drive_sequence_to_scratch(&mut self, fiber_id: FiberId, first: Option<Event>, budget: u32) {
        self.event_scratch.clear();
        self.event_scratch.push(0);
        let mut count = 0u32;
        let mut event = first.unwrap_or_else(|| self.poll_event(fiber_id));
        loop {
            let should_continue = matches!(event, Event::Continue { .. });
            self.push_event_to_scratch(&event);
            self.account_event(&event);
            count += 1;
            if !should_continue || count >= budget {
                break;
            }
            event = self.poll_event(fiber_id);
        }
        self.event_scratch[0] = count;
        self.account_boundary(count as usize);
    }

    fn push_event_to_scratch(&mut self, event: &Event) {
        let words = encode_event_words(event);
        self.event_scratch.extend_from_slice(&words);
    }

    pub fn metric_u64(&self, id: u32) -> f64 {
        let mut running = 0;
        let mut suspended = 0;
        for fiber in self.fibers.iter() {
            match fiber.status {
                FiberStatus::Running => running += 1,
                FiberStatus::Suspended => suspended += 1,
                _ => {}
            }
        }
        match id {
            VM_METRIC_STARTED => self.started as f64,
            VM_METRIC_LIVE => self.fibers.len() as f64,
            VM_METRIC_RUNNING => running as f64,
            VM_METRIC_SUSPENDED => suspended as f64,
            VM_METRIC_COMPLETED => self.completed as f64,
            VM_METRIC_FAILED => self.failed as f64,
            VM_METRIC_INTERRUPTED => self.interrupted as f64,
            VM_METRIC_BOUNDARY_CALLS => self.boundary_calls as f64,
            VM_METRIC_BATCHES_EMITTED => self.batches_emitted as f64,
            VM_METRIC_EVENTS_EMITTED => self.events_emitted as f64,
            VM_METRIC_EVENTS_PER_BOUNDARY_CALL => {
                if self.boundary_calls == 0 {
                    0.0
                } else {
                    self.events_emitted as f64 / self.boundary_calls as f64
                }
            }
            VM_METRIC_MAX_EVENTS_PER_BOUNDARY_CALL => self.max_events_per_boundary_call as f64,
            VM_METRIC_BINARY_PROGRAMS => self.binary_programs as f64,
            VM_METRIC_JSON_PROGRAMS => self.json_programs as f64,
            VM_METRIC_BINARY_PATCHES => self.binary_patches as f64,
            VM_METRIC_JSON_PATCHES => self.json_patches as f64,
            VM_METRIC_ZERO_COPY_PROGRAMS => self.zero_copy_programs as f64,
            VM_METRIC_ZERO_COPY_PATCHES => self.zero_copy_patches as f64,
            VM_METRIC_ZERO_COPY_EVENT_BATCHES => self.zero_copy_event_batches as f64,
            VM_METRIC_FIBER_SLAB_LIVE => self.fibers.live as f64,
            VM_METRIC_FIBER_SLAB_CAPACITY => self.fibers.capacity() as f64,
            VM_METRIC_FIBER_SLAB_REUSED => self.fibers.reused as f64,
            VM_METRIC_FIBER_SLAB_RELEASED => self.fibers.released as f64,
            VM_METRIC_FIBER_SLAB_STALE_READS => self.fibers.stale_reads as f64,
            _ => 0.0,
        }
    }

    pub fn metrics_snapshot_ptr(&mut self) -> u32 {
        self.metrics_scratch.clear();
        for id in 0..VM_METRIC_COUNT as u32 {
            self.metrics_scratch.push(self.metric_u64(id));
        }
        self.metrics_scratch.as_ptr() as u32
    }

    pub fn metrics_snapshot_len(&self) -> usize {
        self.metrics_scratch.len()
    }

    pub fn stats_json(&self) -> String {
        let mut running = 0;
        let mut suspended = 0;
        for fiber in self.fibers.iter() {
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
            boundary_calls: self.boundary_calls,
            batches_emitted: self.batches_emitted,
            events_emitted: self.events_emitted,
            events_per_boundary_call: if self.boundary_calls == 0 {
                0.0
            } else {
                self.events_emitted as f64 / self.boundary_calls as f64
            },
            max_events_per_boundary_call: self.max_events_per_boundary_call,
            binary_programs: self.binary_programs,
            json_programs: self.json_programs,
            binary_patches: self.binary_patches,
            json_patches: self.json_patches,
            zero_copy_programs: self.zero_copy_programs,
            zero_copy_patches: self.zero_copy_patches,
            zero_copy_event_batches: self.zero_copy_event_batches,
            fiber_slab_live: self.fibers.live,
            fiber_slab_capacity: self.fibers.capacity(),
            fiber_slab_reused: self.fibers.reused,
            fiber_slab_released: self.fibers.released,
            fiber_slab_stale_reads: self.fibers.stale_reads,
        })
        .expect("stats json")
    }

    fn account_boundary(&mut self, event_count: usize) {
        self.boundary_calls += 1;
        self.batches_emitted += 1;
        self.events_emitted += event_count as u64;
        self.max_events_per_boundary_call =
            self.max_events_per_boundary_call.max(event_count as u32);
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
            return fiber.last_event.clone().unwrap_or(Event::Interrupted {
                fiber_id: fiber.id,
                reason_ref: 0,
            });
        }
        let Some(current) = fiber.current else {
            return mark_failed(fiber, 0);
        };
        let Some(node) = fiber.program.nodes.get(current as usize).copied() else {
            return mark_failed(fiber, 0);
        };
        match node.tag {
            OP_SUCCEED => return success(fiber, node.a),
            OP_FAIL => return failure(fiber, node.a),
            OP_SYNC => {
                return suspend(
                    fiber,
                    Event::InvokeSync {
                        fiber_id: fiber.id,
                        fn_ref: node.a,
                    },
                )
            }
            OP_ASYNC => {
                return suspend(
                    fiber,
                    Event::InvokeAsync {
                        fiber_id: fiber.id,
                        register_ref: node.a,
                    },
                )
            }
            OP_HOST_ACTION => {
                return suspend(
                    fiber,
                    Event::InvokeHostAction {
                        fiber_id: fiber.id,
                        action_ref: node.a,
                        decode_ref: if node.b == NONE_U32 {
                            None
                        } else {
                            Some(node.b)
                        },
                    },
                );
            }
            OP_FORK => {
                return suspend(
                    fiber,
                    Event::InvokeFork {
                        fiber_id: fiber.id,
                        effect_ref: node.a,
                        scope_id: if node.b == NONE_U32 {
                            None
                        } else {
                            Some(node.b)
                        },
                    },
                );
            }
            OP_FLAT_MAP => {
                fiber.stack.push(Frame::SuccessCont { fn_ref: node.b });
                fiber.current = Some(node.a);
            }
            OP_FOLD => {
                fiber.stack.push(Frame::FoldCont {
                    on_failure_ref: node.b,
                    on_success_ref: node.c,
                });
                fiber.current = Some(node.a);
            }
            _ => return mark_failed(fiber, 0),
        }
    }
}

fn success(fiber: &mut FiberVm, value_ref: RefId) -> Event {
    let Some(frame) = fiber.stack.pop() else {
        return mark_done(fiber, value_ref);
    };
    match frame {
        Frame::SuccessCont { fn_ref } => suspend(
            fiber,
            Event::InvokeFlatMap {
                fiber_id: fiber.id,
                fn_ref,
                value_ref,
            },
        ),
        Frame::FoldCont { on_success_ref, .. } => suspend(
            fiber,
            Event::InvokeFoldSuccess {
                fiber_id: fiber.id,
                fn_ref: on_success_ref,
                value_ref,
            },
        ),
    }
}

fn failure(fiber: &mut FiberVm, error_ref: RefId) -> Event {
    while let Some(frame) = fiber.stack.pop() {
        match frame {
            Frame::SuccessCont { .. } => continue,
            Frame::FoldCont { on_failure_ref, .. } => {
                return suspend(
                    fiber,
                    Event::InvokeFoldFailure {
                        fiber_id: fiber.id,
                        fn_ref: on_failure_ref,
                        error_ref,
                    },
                )
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
    let event = Event::Done {
        fiber_id: fiber.id,
        value_ref,
    };
    fiber.last_event = Some(event.clone());
    event
}

fn mark_failed(fiber: &mut FiberVm, error_ref: RefId) -> Event {
    fiber.status = FiberStatus::Failed;
    fiber.current = None;
    let event = Event::Failed {
        fiber_id: fiber.id,
        error_ref,
    };
    fiber.last_event = Some(event.clone());
    event
}

const TIMER_EVENT_WORDS: usize = 5;

#[derive(Clone, Copy)]
struct TimerEntry {
    id: TimerId,
    subject_id: u32,
    kind: u32,
    deadline_ms: u64,
    canceled: bool,
}

#[wasm_bindgen]
pub struct BrassWasmTimerWheel {
    tick_ms: u64,
    buckets: Vec<Vec<TimerEntry>>,
    next_timer_id: TimerId,
    live: usize,
    scheduled: u64,
    canceled: u64,
    expired: u64,
    expired_scratch: Vec<u32>,
    metrics_scratch: Vec<f64>,
}

#[wasm_bindgen]
impl BrassWasmTimerWheel {
    #[wasm_bindgen(constructor)]
    pub fn new(tick_ms: u64, bucket_count: usize) -> BrassWasmTimerWheel {
        let count = next_pow2(bucket_count.max(8));
        BrassWasmTimerWheel {
            tick_ms: tick_ms.max(1),
            buckets: vec![Vec::new(); count],
            next_timer_id: 1,
            live: 0,
            scheduled: 0,
            canceled: 0,
            expired: 0,
            expired_scratch: Vec::new(),
            metrics_scratch: Vec::new(),
        }
    }

    pub fn memory(&self) -> JsValue {
        wasm_bindgen::memory()
    }

    pub fn schedule_deadline(&mut self, subject_id: u32, kind: u32, deadline_ms: u64) -> TimerId {
        let id = self.next_timer_id;
        self.next_timer_id = self.next_timer_id.wrapping_add(1).max(1);
        let idx = self.bucket_index(deadline_ms);
        self.buckets[idx].push(TimerEntry {
            id,
            subject_id,
            kind,
            deadline_ms,
            canceled: false,
        });
        self.live += 1;
        self.scheduled += 1;
        id
    }

    pub fn cancel(&mut self, timer_id: TimerId) -> bool {
        for bucket in &mut self.buckets {
            for entry in bucket.iter_mut() {
                if entry.id == timer_id && !entry.canceled {
                    entry.canceled = true;
                    self.live = self.live.saturating_sub(1);
                    self.canceled += 1;
                    return true;
                }
            }
        }
        false
    }

    pub fn advance_time(&mut self, now_ms: u64) -> u32 {
        self.expired_scratch.clear();
        self.expired_scratch.push(0);
        let mut count = 0u32;
        for bucket in &mut self.buckets {
            let mut keep = Vec::with_capacity(bucket.len());
            for entry in bucket.drain(..) {
                if entry.canceled {
                    continue;
                }
                if entry.deadline_ms <= now_ms {
                    self.expired_scratch.push(entry.id);
                    self.expired_scratch.push(entry.subject_id);
                    self.expired_scratch.push(entry.kind);
                    self.expired_scratch
                        .push((entry.deadline_ms & 0xffff_ffff) as u32);
                    self.expired_scratch.push((entry.deadline_ms >> 32) as u32);
                    count += 1;
                    self.live = self.live.saturating_sub(1);
                    self.expired += 1;
                } else {
                    keep.push(entry);
                }
            }
            *bucket = keep;
        }
        self.expired_scratch[0] = count;
        self.expired_scratch.as_ptr() as u32
    }

    pub fn expired_len(&self) -> usize {
        self.expired_scratch.len()
    }

    pub fn next_deadline_ms(&self) -> f64 {
        let mut next: Option<u64> = None;
        for bucket in &self.buckets {
            for entry in bucket {
                if entry.canceled {
                    continue;
                }
                next = Some(match next {
                    Some(current) => current.min(entry.deadline_ms),
                    None => entry.deadline_ms,
                });
            }
        }
        next.map(|n| n as f64).unwrap_or(-1.0)
    }

    pub fn metric_u64(&self, id: u32) -> f64 {
        match id {
            0 => self.live as f64,
            1 => self.scheduled as f64,
            2 => self.canceled as f64,
            3 => self.expired as f64,
            4 => self.buckets.len() as f64,
            _ => 0.0,
        }
    }

    pub fn metrics_snapshot_ptr(&mut self) -> u32 {
        self.metrics_scratch.clear();
        for id in 0..5 {
            self.metrics_scratch.push(self.metric_u64(id));
        }
        self.metrics_scratch.as_ptr() as u32
    }

    pub fn metrics_snapshot_len(&self) -> usize {
        self.metrics_scratch.len()
    }

    fn bucket_index(&self, deadline_ms: u64) -> usize {
        ((deadline_ms / self.tick_ms) as usize) & (self.buckets.len() - 1)
    }
}

const HTTP_PERMIT_RUN_NOW: u32 = 0;
const HTTP_PERMIT_QUEUED: u32 = 1;
const HTTP_PERMIT_REJECTED: u32 = 2;

#[derive(Clone, Copy)]
struct HttpWaiter {
    permit_id: PermitId,
    subject_id: u32,
    deadline_ms: u64,
}

struct HttpPermitState {
    key_id: u32,
    running: usize,
    queue: VecDeque<HttpWaiter>,
    acquired: u64,
    released: u64,
    rejected: u64,
    queued: u64,
    queue_timeouts: u64,
    cancelled: u64,
}

#[wasm_bindgen]
pub struct BrassWasmHttpPermitPool {
    concurrency: usize,
    max_queue: usize,
    queue_timeout_ms: u64,
    keys: HashMap<String, u32>,
    states: HashMap<u32, HttpPermitState>,
    next_key_id: u32,
    next_permit_id: PermitId,
    last_permit_id: PermitId,
    event_scratch: Vec<u32>,
    metrics_scratch: Vec<f64>,
}

#[wasm_bindgen]
impl BrassWasmHttpPermitPool {
    #[wasm_bindgen(constructor)]
    pub fn new(
        concurrency: usize,
        max_queue: usize,
        queue_timeout_ms: u64,
    ) -> BrassWasmHttpPermitPool {
        BrassWasmHttpPermitPool {
            concurrency: concurrency.max(1),
            max_queue,
            queue_timeout_ms,
            keys: HashMap::new(),
            states: HashMap::new(),
            next_key_id: 1,
            next_permit_id: 1,
            last_permit_id: 0,
            event_scratch: Vec::new(),
            metrics_scratch: Vec::new(),
        }
    }

    pub fn memory(&self) -> JsValue {
        wasm_bindgen::memory()
    }

    pub fn intern_key(&mut self, key: &str) -> u32 {
        let clean = sanitize_lane_key(key);
        if let Some(id) = self.keys.get(&clean) {
            return *id;
        }
        let id = self.next_key_id;
        self.next_key_id = self.next_key_id.wrapping_add(1).max(1);
        self.keys.insert(clean, id);
        self.states.insert(
            id,
            HttpPermitState {
                key_id: id,
                running: 0,
                queue: VecDeque::new(),
                acquired: 0,
                released: 0,
                rejected: 0,
                queued: 0,
                queue_timeouts: 0,
                cancelled: 0,
            },
        );
        id
    }

    pub fn acquire(&mut self, subject_id: u32, key_id: u32, now_ms: u64) -> u32 {
        let permit_id = self.next_permit_id;
        self.next_permit_id = self.next_permit_id.wrapping_add(1).max(1);
        self.last_permit_id = permit_id;
        let state = self.states.entry(key_id).or_insert(HttpPermitState {
            key_id,
            running: 0,
            queue: VecDeque::new(),
            acquired: 0,
            released: 0,
            rejected: 0,
            queued: 0,
            queue_timeouts: 0,
            cancelled: 0,
        });
        if state.running < self.concurrency {
            state.running += 1;
            state.acquired += 1;
            return HTTP_PERMIT_RUN_NOW;
        }
        if state.queue.len() >= self.max_queue {
            state.rejected += 1;
            return HTTP_PERMIT_REJECTED;
        }
        state.queued += 1;
        let deadline_ms = if self.queue_timeout_ms == 0 {
            u64::MAX
        } else {
            now_ms.saturating_add(self.queue_timeout_ms)
        };
        state.queue.push_back(HttpWaiter {
            permit_id,
            subject_id,
            deadline_ms,
        });
        HTTP_PERMIT_QUEUED
    }

    pub fn last_permit_id(&self) -> PermitId {
        self.last_permit_id
    }

    pub fn release(&mut self, key_id: u32, now_ms: u64) -> u32 {
        if let Some(state) = self.states.get_mut(&key_id) {
            state.running = state.running.saturating_sub(1);
            state.released += 1;
        }
        self.drain_key_to_scratch(key_id, now_ms)
    }

    pub fn cancel(&mut self, permit_id: PermitId) -> bool {
        for state in self.states.values_mut() {
            let before = state.queue.len();
            state.queue.retain(|waiter| waiter.permit_id != permit_id);
            if state.queue.len() != before {
                state.cancelled += 1;
                return true;
            }
        }
        false
    }

    pub fn advance_time(&mut self, now_ms: u64) -> u32 {
        self.event_scratch.clear();
        self.event_scratch.push(0);
        let mut count = 0u32;
        for state in self.states.values_mut() {
            let mut keep = VecDeque::new();
            while let Some(waiter) = state.queue.pop_front() {
                if waiter.deadline_ms <= now_ms {
                    state.queue_timeouts += 1;
                    self.event_scratch.push(waiter.subject_id);
                    self.event_scratch.push(waiter.permit_id);
                    self.event_scratch.push(state.key_id);
                    count += 1;
                } else {
                    keep.push_back(waiter);
                }
            }
            state.queue = keep;
        }
        self.event_scratch[0] = count;
        self.event_scratch.as_ptr() as u32
    }

    pub fn permit_events_len(&self) -> usize {
        self.event_scratch.len()
    }

    pub fn next_deadline_ms(&self) -> f64 {
        let mut next: Option<u64> = None;
        for state in self.states.values() {
            for waiter in &state.queue {
                if waiter.deadline_ms == u64::MAX {
                    continue;
                }
                next = Some(match next {
                    Some(current) => current.min(waiter.deadline_ms),
                    None => waiter.deadline_ms,
                });
            }
        }
        next.map(|n| n as f64).unwrap_or(-1.0)
    }

    pub fn metric_u64(&self, id: u32) -> f64 {
        let mut running = 0usize;
        let mut queued = 0usize;
        let mut acquired = 0u64;
        let mut released = 0u64;
        let mut rejected = 0u64;
        let mut timeouts = 0u64;
        for state in self.states.values() {
            running += state.running;
            queued += state.queue.len();
            acquired += state.acquired;
            released += state.released;
            rejected += state.rejected;
            timeouts += state.queue_timeouts;
        }
        match id {
            0 => running as f64,
            1 => queued as f64,
            2 => acquired as f64,
            3 => released as f64,
            4 => rejected as f64,
            5 => timeouts as f64,
            6 => self.states.len() as f64,
            _ => 0.0,
        }
    }

    pub fn metrics_snapshot_ptr(&mut self) -> u32 {
        self.metrics_scratch.clear();
        for id in 0..7 {
            self.metrics_scratch.push(self.metric_u64(id));
        }
        self.metrics_scratch.as_ptr() as u32
    }

    pub fn metrics_snapshot_len(&self) -> usize {
        self.metrics_scratch.len()
    }

    fn drain_key_to_scratch(&mut self, key_id: u32, now_ms: u64) -> u32 {
        self.event_scratch.clear();
        self.event_scratch.push(0);
        let mut count = 0u32;
        if let Some(state) = self.states.get_mut(&key_id) {
            while state.running < self.concurrency {
                let Some(waiter) = state.queue.pop_front() else {
                    break;
                };
                if waiter.deadline_ms <= now_ms {
                    state.queue_timeouts += 1;
                    continue;
                }
                state.running += 1;
                state.acquired += 1;
                self.event_scratch.push(waiter.subject_id);
                self.event_scratch.push(waiter.permit_id);
                self.event_scratch.push(key_id);
                count += 1;
            }
        }
        self.event_scratch[0] = count;
        self.event_scratch.as_ptr() as u32
    }
}

#[derive(Clone, Copy)]
struct RetryState {
    started_at_ms: f64,
    attempt: u32,
    max_retries: u32,
    base_delay_ms: f64,
    max_delay_ms: f64,
    max_elapsed_ms: f64,
    seed: u64,
}

#[wasm_bindgen]
pub struct BrassWasmRetryPlanner {
    states: HashMap<RetryId, RetryState>,
    next_retry_id: RetryId,
    planned: u64,
    exhausted: u64,
    dropped: u64,
    metrics_scratch: Vec<f64>,
}

#[wasm_bindgen]
impl BrassWasmRetryPlanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BrassWasmRetryPlanner {
        BrassWasmRetryPlanner {
            states: HashMap::new(),
            next_retry_id: 1,
            planned: 0,
            exhausted: 0,
            dropped: 0,
            metrics_scratch: Vec::new(),
        }
    }

    pub fn memory(&self) -> JsValue {
        wasm_bindgen::memory()
    }

    pub fn start(
        &mut self,
        now_ms: f64,
        max_retries: u32,
        base_delay_ms: f64,
        max_delay_ms: f64,
        max_elapsed_ms: f64,
        seed: u64,
    ) -> RetryId {
        let id = self.next_retry_id;
        self.next_retry_id = self.next_retry_id.wrapping_add(1).max(1);
        self.states.insert(
            id,
            RetryState {
                started_at_ms: now_ms,
                attempt: 0,
                max_retries,
                base_delay_ms: base_delay_ms.max(0.0),
                max_delay_ms: max_delay_ms.max(0.0),
                max_elapsed_ms,
                seed: if seed == 0 {
                    (id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
                } else {
                    seed
                },
            },
        );
        id
    }

    pub fn next_delay_ms(
        &mut self,
        retry_id: RetryId,
        now_ms: f64,
        retryable: bool,
        retry_after_ms: f64,
    ) -> f64 {
        let Some(state) = self.states.get_mut(&retry_id) else {
            return -1.0;
        };
        if !retryable || state.attempt >= state.max_retries {
            self.exhausted += 1;
            return -1.0;
        }
        let exp = state.base_delay_ms * 2_f64.powi(state.attempt.min(30) as i32);
        let cap = exp.max(0.0).min(state.max_delay_ms.max(0.0));
        let mut delay = if retry_after_ms >= 0.0 {
            retry_after_ms.min(state.max_delay_ms)
        } else {
            jitter_ms(&mut state.seed, cap)
        };
        if state.max_elapsed_ms >= 0.0 {
            let remaining = state.max_elapsed_ms - (now_ms - state.started_at_ms);
            if remaining <= 0.0 {
                self.exhausted += 1;
                return -1.0;
            }
            delay = delay.min(remaining);
        }
        state.attempt += 1;
        self.planned += 1;
        delay.max(0.0).floor()
    }

    pub fn drop_state(&mut self, retry_id: RetryId) -> bool {
        let existed = self.states.remove(&retry_id).is_some();
        if existed {
            self.dropped += 1;
        }
        existed
    }

    pub fn metric_u64(&self, id: u32) -> f64 {
        match id {
            0 => self.states.len() as f64,
            1 => self.planned as f64,
            2 => self.exhausted as f64,
            3 => self.dropped as f64,
            _ => 0.0,
        }
    }

    pub fn metrics_snapshot_ptr(&mut self) -> u32 {
        self.metrics_scratch.clear();
        for id in 0..4 {
            self.metrics_scratch.push(self.metric_u64(id));
        }
        self.metrics_scratch.as_ptr() as u32
    }

    pub fn metrics_snapshot_len(&self) -> usize {
        self.metrics_scratch.len()
    }
}

fn jitter_ms(seed: &mut u64, cap: f64) -> f64 {
    if cap <= 0.0 {
        return 0.0;
    }
    let rnd = xorshift64(seed);
    let unit = (rnd as f64) / (u64::MAX as f64);
    (unit * cap).floor()
}

fn xorshift64(seed: &mut u64) -> u64 {
    let mut x = *seed;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *seed = x;
    x
}
