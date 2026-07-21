use std::collections::HashMap;

pub type LaneId = u32;

pub const SCHEDULER_POLICY_MICRO: u32 = 0;
pub const SCHEDULER_POLICY_MACRO: u32 = 1;
pub const SCHEDULER_POLICY_NONE: u32 = 2;
pub const SCHEDULER_POLICY_DROPPED: u32 = 3;
pub const DEFAULT_LANE_CAPACITY: usize = 1_024;
pub const DEFAULT_LANE_BUDGET: usize = 64;
pub const DEFAULT_MAX_LANES: usize = 256;
pub const MAX_LANE_CAPACITY: usize = 1 << 20;
pub const MAX_LANES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerPhase {
    Idle,
    ScheduledMicro,
    ScheduledMacro,
    Flushing,
}

impl SchedulerPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::ScheduledMicro => "scheduledMicro",
            Self::ScheduledMacro => "scheduledMacro",
            Self::Flushing => "flushing",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneStats {
    pub id: LaneId,
    pub key: String,
    pub len: usize,
    pub capacity: usize,
    pub enqueued_tasks: u64,
    pub executed_tasks: u64,
    pub dropped_tasks: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulerStats {
    pub phase: SchedulerPhase,
    pub len: usize,
    pub capacity: usize,
    pub scheduled_flushes: u64,
    pub completed_flushes: u64,
    pub enqueued_tasks: u64,
    pub executed_tasks: u64,
    pub dropped_tasks: u64,
    pub yielded_by_budget: u64,
    pub lane_intern_hits: u64,
    pub lane_intern_misses: u64,
    pub lanes: Vec<LaneStats>,
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
    fn new(id: LaneId, key: String, capacity: usize) -> Self {
        let cap = capacity.clamp(2, MAX_LANE_CAPACITY).next_power_of_two();
        Self {
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
            capacity: self.queue.len(),
            enqueued_tasks: self.enqueued_tasks,
            executed_tasks: self.executed_tasks,
            dropped_tasks: self.dropped_tasks,
        }
    }
}

pub struct SchedulerStateMachine {
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

impl SchedulerStateMachine {
    pub fn new(
        max_capacity: usize,
        flush_budget: usize,
        micro_threshold: usize,
        lane_capacity: usize,
        lane_budget: usize,
        max_lanes: usize,
    ) -> Self {
        Self {
            lanes: Vec::new(),
            lane_index: HashMap::new(),
            rr_index: 0,
            rr_remaining: 0,
            total_len: 0,
            phase: SchedulerPhase::Idle,
            flush_budget: flush_budget.max(1),
            micro_threshold: micro_threshold.max(1),
            lane_capacity: if lane_capacity == 0 {
                max_capacity.clamp(DEFAULT_LANE_CAPACITY, MAX_LANE_CAPACITY)
            } else {
                lane_capacity.min(MAX_LANE_CAPACITY)
            },
            lane_budget: if lane_budget == 0 {
                DEFAULT_LANE_BUDGET
            } else {
                lane_budget
            },
            max_lanes: if max_lanes == 0 {
                DEFAULT_MAX_LANES
            } else {
                max_lanes.min(MAX_LANES)
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

    pub const fn len(&self) -> usize {
        self.total_len
    }
    pub const fn is_empty(&self) -> bool {
        self.total_len == 0
    }
    pub fn capacity(&self) -> usize {
        self.lanes.iter().map(|lane| lane.queue.len()).sum()
    }
    pub const fn is_flushing(&self) -> bool {
        matches!(self.phase, SchedulerPhase::Flushing)
    }
    pub const fn is_scheduled(&self) -> bool {
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
        let lane_id = self.intern_lane(&infer_lane(tag));
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

    pub fn shift(&mut self) -> Option<u32> {
        let (lane_idx, task_ref) = self.shift_from_next_lane()?;
        self.total_len -= 1;
        self.executed_tasks += 1;
        self.lanes[lane_idx].executed_tasks += 1;
        Some(task_ref)
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
            .map_or(0, |lane| lane.len)
    }

    pub fn metric(&self, id: u32) -> u64 {
        match id {
            0 => self.total_len as u64,
            1 => self.enqueued_tasks,
            2 => self.executed_tasks,
            3 => self.dropped_tasks,
            4 => self.yielded_by_budget,
            5 => self.lane_intern_hits,
            6 => self.lane_intern_misses,
            7 => self.lanes.len() as u64,
            _ => 0,
        }
    }

    pub fn stats(&self) -> SchedulerStats {
        SchedulerStats {
            phase: self.phase,
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
        }
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
        (idx < self.lanes.len()).then_some(idx)
    }
    fn lane_idx_or_overflow(&mut self, lane_id: LaneId) -> usize {
        if let Some(idx) = self.lane_id_to_idx(lane_id) {
            return idx;
        }
        let overflow = self.get_or_create_lane_id("overflow");
        self.lane_id_to_idx(overflow).unwrap_or(0)
    }
    fn get_or_create_lane_id(&mut self, requested_key: &str) -> LaneId {
        if let Some(id) = self.lane_index.get(requested_key) {
            return *id;
        }
        let key = if self.lane_index.len() >= self.max_lanes {
            "overflow"
        } else {
            requested_key
        };
        if let Some(id) = self.lane_index.get(key) {
            return *id;
        }
        let id = (self.lanes.len() as LaneId).saturating_add(1);
        self.lanes
            .push(LaneState::new(id, key.to_owned(), self.lane_capacity));
        self.lane_index.insert(key.to_owned(), id);
        id
    }
    fn shift_from_next_lane(&mut self) -> Option<(usize, u32)> {
        let count = self.lanes.len();
        if count == 0 {
            return None;
        }
        if self.rr_remaining > 0 {
            let current = (self.rr_index + count - 1) % count;
            if let Some(task) = self.lanes[current].shift() {
                self.rr_remaining -= 1;
                return Some((current, task));
            }
            self.rr_remaining = 0;
        }
        for _ in 0..count {
            let idx = self.rr_index % count;
            self.rr_index = (idx + 1) % count;
            if self.lanes[idx].len == 0 {
                continue;
            }
            self.rr_remaining = self.lane_budget.saturating_sub(1);
            if let Some(task) = self.lanes[idx].shift() {
                return Some((idx, task));
            }
        }
        None
    }
}

pub fn sanitize_lane_key(value: &str) -> String {
    let mut out = String::new();
    let mut whitespace = false;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            if !whitespace && !out.is_empty() {
                out.push(':');
            }
            whitespace = true;
            continue;
        }
        whitespace = false;
        out.push(
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '#' | '-') {
                ch
            } else {
                '_'
            },
        );
        if out.len() >= 160 {
            break;
        }
    }
    if out.is_empty() {
        "anonymous".to_owned()
    } else {
        out
    }
}

pub fn infer_lane(tag: &str) -> String {
    for prefix in ["lane:", "caller:"] {
        if let Some(rest) = tag.strip_prefix(prefix) {
            if let Some(end) = rest.find('|') {
                if end > 0 {
                    return sanitize_lane_key(&rest[..end]);
                }
            }
        }
    }
    sanitize_lane_key(tag.split(['.', '#', '/']).next().unwrap_or(tag))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn model_property_preserves_accepted_tasks_and_bounds_lanes() {
        for seed in 1..=128u64 {
            let mut state = SchedulerStateMachine::new(8, 7, 4, 8, 3, 4);
            let mut models = [VecDeque::new(), VecDeque::new(), VecDeque::new()];
            let ids = [
                state.intern_lane("a"),
                state.intern_lane("b"),
                state.intern_lane("c"),
            ];
            let mut random = seed;
            for task in 1..=200u32 {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                let lane = (random as usize) % ids.len();
                let policy = state.enqueue_lane(task, ids[lane]);
                if policy != SCHEDULER_POLICY_DROPPED {
                    models[lane].push_back(task);
                }
                assert!(state.len() <= 24);
            }
            let mut observed = Vec::new();
            while !state.is_empty() {
                observed.push(state.shift().expect("queued task"));
            }
            let expected_count: usize = models.iter().map(VecDeque::len).sum();
            assert_eq!(observed.len(), expected_count);
            for lane in models {
                let ordered: Vec<_> = observed
                    .iter()
                    .copied()
                    .filter(|task| lane.contains(task))
                    .collect();
                assert_eq!(ordered, lane.into_iter().collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn invalid_sizes_are_clamped_before_allocation() {
        let mut state = SchedulerStateMachine::new(usize::MAX, 0, 0, usize::MAX, 0, usize::MAX);
        state.intern_lane("x");
        assert_eq!(state.stats().lanes[0].capacity, MAX_LANE_CAPACITY);
    }
}
