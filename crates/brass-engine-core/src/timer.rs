pub type TimerId = u32;
pub const MAX_TIMER_BUCKETS: usize = 1 << 20;
pub const MAX_TIMERS: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimerEntry {
    pub id: TimerId,
    pub subject_id: u32,
    pub kind: u32,
    pub deadline_ms: u64,
    canceled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimerWheelStats {
    pub live: usize,
    pub scheduled: u64,
    pub canceled: u64,
    pub expired: u64,
    pub buckets: usize,
}

pub struct TimerWheel {
    tick_ms: u64,
    buckets: Vec<Vec<TimerEntry>>,
    next_timer_id: TimerId,
    stats: TimerWheelStats,
}

impl TimerWheel {
    pub fn new(tick_ms: u64, bucket_count: usize) -> Self {
        let count = bucket_count.clamp(8, MAX_TIMER_BUCKETS).next_power_of_two();
        Self {
            tick_ms: tick_ms.max(1),
            buckets: vec![Vec::new(); count],
            next_timer_id: 1,
            stats: TimerWheelStats {
                live: 0,
                scheduled: 0,
                canceled: 0,
                expired: 0,
                buckets: count,
            },
        }
    }

    pub fn schedule(&mut self, subject_id: u32, kind: u32, deadline_ms: u64) -> Option<TimerId> {
        if self.stats.live >= MAX_TIMERS {
            return None;
        }
        let id = self.next_timer_id;
        self.next_timer_id = self.next_timer_id.wrapping_add(1).max(1);
        let index = self.bucket_index(deadline_ms);
        self.buckets[index].push(TimerEntry {
            id,
            subject_id,
            kind,
            deadline_ms,
            canceled: false,
        });
        self.stats.live += 1;
        self.stats.scheduled += 1;
        Some(id)
    }

    pub fn cancel(&mut self, timer_id: TimerId) -> bool {
        for bucket in &mut self.buckets {
            if let Some(entry) = bucket
                .iter_mut()
                .find(|entry| entry.id == timer_id && !entry.canceled)
            {
                entry.canceled = true;
                self.stats.live = self.stats.live.saturating_sub(1);
                self.stats.canceled += 1;
                return true;
            }
        }
        false
    }

    pub fn advance(&mut self, now_ms: u64) -> Vec<TimerEntry> {
        let mut expired = Vec::new();
        for bucket in &mut self.buckets {
            let mut keep = Vec::with_capacity(bucket.len());
            for entry in bucket.drain(..) {
                if entry.canceled {
                    continue;
                }
                if entry.deadline_ms <= now_ms {
                    expired.push(entry);
                    self.stats.live = self.stats.live.saturating_sub(1);
                    self.stats.expired += 1;
                } else {
                    keep.push(entry);
                }
            }
            *bucket = keep;
        }
        expired.sort_unstable_by_key(|entry| (entry.deadline_ms, entry.id));
        expired
    }

    pub fn next_deadline(&self) -> Option<u64> {
        self.buckets
            .iter()
            .flatten()
            .filter(|entry| !entry.canceled)
            .map(|entry| entry.deadline_ms)
            .min()
    }
    pub const fn stats(&self) -> TimerWheelStats {
        self.stats
    }
    fn bucket_index(&self, deadline_ms: u64) -> usize {
        ((deadline_ms / self.tick_ms) as usize) & (self.buckets.len() - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn randomized_deadline_model_expires_once_in_order() {
        for seed in 1..=128u64 {
            let mut wheel = TimerWheel::new(10, 16);
            let mut random = seed;
            let mut expected = Vec::new();
            for subject in 1..=100 {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                let deadline = random % 1_000;
                let id = wheel
                    .schedule(subject, 1, deadline)
                    .expect("timer capacity");
                if subject % 7 == 0 {
                    assert!(wheel.cancel(id));
                } else {
                    expected.push((deadline, id));
                }
            }
            expected.sort_unstable();
            let actual: Vec<_> = wheel
                .advance(u64::MAX)
                .into_iter()
                .map(|entry| (entry.deadline_ms, entry.id))
                .collect();
            assert_eq!(actual, expected);
            assert_eq!(wheel.stats().live, 0);
            assert!(wheel.advance(u64::MAX).is_empty());
        }
    }
}
