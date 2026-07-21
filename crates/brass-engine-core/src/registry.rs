use std::collections::{HashMap, VecDeque};

pub type RegistryFiberId = u32;
pub const FIBER_STATE_QUEUED: u32 = 0;
pub const FIBER_STATE_RUNNING: u32 = 1;
pub const FIBER_STATE_SUSPENDED: u32 = 2;
pub const FIBER_STATE_DONE: u32 = 3;
pub const FIBER_STATE_FAILED: u32 = 4;
pub const FIBER_STATE_INTERRUPTED: u32 = 5;
pub const MAX_REGISTRY_FIBERS: usize = 1_048_576;

#[derive(Debug, Clone, Copy)]
struct Entry {
    state: u32,
    parent_id: RegistryFiberId,
    scope_id: u32,
    created_at_ms: f64,
    last_active_at_ms: f64,
    joiners: u32,
    wake_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FiberMetadata {
    pub parent_id: RegistryFiberId,
    pub scope_id: u32,
    pub created_at_ms: f64,
    pub last_active_at_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FiberRegistryStats {
    pub live: usize,
    pub queued: u64,
    pub running: u64,
    pub suspended: u64,
    pub done: u64,
    pub failed: u64,
    pub interrupted: u64,
    pub wake_queue_len: usize,
    pub registered: u64,
    pub completed: u64,
    pub wakeups: u64,
    pub duplicate_wakeups: u64,
    pub joins: u64,
}

#[derive(Default)]
pub struct FiberRegistry {
    entries: HashMap<RegistryFiberId, Entry>,
    wake_queue: VecDeque<RegistryFiberId>,
    registered: u64,
    completed: u64,
    wakeups: u64,
    duplicate_wakeups: u64,
    joins: u64,
}

impl FiberRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register(&mut self, fiber_id: RegistryFiberId, now_ms: f64) -> bool {
        self.register_with_context(fiber_id, 0, 0, now_ms)
    }
    pub fn register_with_context(
        &mut self,
        fiber_id: RegistryFiberId,
        parent_id: RegistryFiberId,
        scope_id: u32,
        now_ms: f64,
    ) -> bool {
        if !now_ms.is_finite() {
            return false;
        }
        if self.entries.len() >= MAX_REGISTRY_FIBERS && !self.entries.contains_key(&fiber_id) {
            return false;
        }
        let existed = self
            .entries
            .insert(
                fiber_id,
                Entry {
                    state: FIBER_STATE_RUNNING,
                    parent_id,
                    scope_id,
                    created_at_ms: now_ms,
                    last_active_at_ms: now_ms,
                    joiners: 0,
                    wake_pending: false,
                },
            )
            .is_some();
        if !existed {
            self.registered += 1;
        }
        !existed
    }
    pub fn set_state(&mut self, id: RegistryFiberId, state: u32, now_ms: f64) -> bool {
        if state > FIBER_STATE_INTERRUPTED || !now_ms.is_finite() {
            return false;
        }
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        entry.state = state;
        entry.last_active_at_ms = now_ms;
        true
    }
    pub fn mark_done(&mut self, id: RegistryFiberId, state: u32, now_ms: f64) -> u32 {
        if !(FIBER_STATE_DONE..=FIBER_STATE_INTERRUPTED).contains(&state) || !now_ms.is_finite() {
            return 0;
        }
        let Some(entry) = self.entries.get_mut(&id) else {
            return 0;
        };
        if entry.state < FIBER_STATE_DONE {
            self.completed += 1;
        }
        entry.state = state;
        entry.last_active_at_ms = now_ms;
        let joiners = entry.joiners;
        entry.joiners = 0;
        joiners
    }
    pub fn drop_fiber(&mut self, id: RegistryFiberId) -> bool {
        self.entries.remove(&id).is_some()
    }
    pub fn add_joiner(&mut self, id: RegistryFiberId) -> u32 {
        let Some(entry) = self.entries.get_mut(&id) else {
            return 0;
        };
        self.joins += 1;
        entry.joiners = entry.joiners.saturating_add(1);
        entry.joiners
    }
    pub fn wake(&mut self, id: RegistryFiberId) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if entry.wake_pending {
            self.duplicate_wakeups += 1;
            return false;
        }
        entry.wake_pending = true;
        self.wakeups += 1;
        self.wake_queue.push_back(id);
        true
    }
    pub fn drain_wakeup(&mut self) -> Option<RegistryFiberId> {
        while let Some(id) = self.wake_queue.pop_front() {
            if let Some(entry) = self.entries.get_mut(&id) {
                entry.wake_pending = false;
                return Some(id);
            }
        }
        None
    }
    pub fn wake_queue_len(&self) -> usize {
        self.wake_queue.len()
    }
    pub fn state_of(&self, id: RegistryFiberId) -> Option<u32> {
        self.entries.get(&id).map(|entry| entry.state)
    }
    pub fn metadata_of(&self, id: RegistryFiberId) -> Option<FiberMetadata> {
        self.entries.get(&id).map(|entry| FiberMetadata {
            parent_id: entry.parent_id,
            scope_id: entry.scope_id,
            created_at_ms: entry.created_at_ms,
            last_active_at_ms: entry.last_active_at_ms,
        })
    }
    pub fn stats(&self) -> FiberRegistryStats {
        let mut stats = FiberRegistryStats {
            live: self.entries.len(),
            queued: 0,
            running: 0,
            suspended: 0,
            done: 0,
            failed: 0,
            interrupted: 0,
            wake_queue_len: self.wake_queue.len(),
            registered: self.registered,
            completed: self.completed,
            wakeups: self.wakeups,
            duplicate_wakeups: self.duplicate_wakeups,
            joins: self.joins,
        };
        for entry in self.entries.values() {
            match entry.state {
                FIBER_STATE_QUEUED => stats.queued += 1,
                FIBER_STATE_RUNNING => stats.running += 1,
                FIBER_STATE_SUSPENDED => stats.suspended += 1,
                FIBER_STATE_DONE => stats.done += 1,
                FIBER_STATE_FAILED => stats.failed += 1,
                FIBER_STATE_INTERRUPTED => stats.interrupted += 1,
                _ => {}
            }
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wakeups_are_coalesced_and_dropped_fibers_do_not_escape() {
        for count in 1..=256u32 {
            let mut registry = FiberRegistry::new();
            for id in 1..=count {
                assert!(registry.register(id, 0.0));
                assert!(registry.wake(id));
                assert!(!registry.wake(id));
                if id % 5 == 0 {
                    registry.drop_fiber(id);
                }
            }
            let mut drained = Vec::new();
            while let Some(id) = registry.drain_wakeup() {
                drained.push(id);
            }
            assert!(drained.iter().all(|id| id % 5 != 0));
            assert_eq!(drained.len(), registry.stats().live);
            assert_eq!(registry.wake_queue_len(), 0);
        }
    }

    #[test]
    fn preserves_context_and_rejects_invalid_state_or_time() {
        let mut registry = FiberRegistry::new();
        assert!(registry.register_with_context(2, 1, 9, 10.0));
        assert_eq!(
            registry.metadata_of(2),
            Some(FiberMetadata {
                parent_id: 1,
                scope_id: 9,
                created_at_ms: 10.0,
                last_active_at_ms: 10.0,
            })
        );
        assert!(!registry.set_state(2, u32::MAX, 11.0));
        assert_eq!(registry.state_of(2), Some(FIBER_STATE_RUNNING));
        assert_eq!(registry.mark_done(2, FIBER_STATE_DONE, f64::NAN), 0);
        assert!(!registry.register(3, f64::INFINITY));
    }
}
