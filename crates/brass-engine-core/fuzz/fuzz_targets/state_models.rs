#![no_main]

use brass_engine_core::{FiberRegistry, GenerationalSlab, SchedulerStateMachine, TimerWheel};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut scheduler = SchedulerStateMachine::new(32, 16, 8, 32, 4, 16);
    let mut registry = FiberRegistry::new();
    let mut timers = TimerWheel::new(10, 32);
    let mut slab = GenerationalSlab::new();
    let mut ids = Vec::new();

    for (index, chunk) in data.chunks(4).take(16_384).enumerate() {
        let value = chunk
            .iter()
            .fold(0u32, |acc, byte| acc.rotate_left(5) ^ u32::from(*byte));
        match value & 7 {
            0 => {
                scheduler.enqueue(
                    value,
                    if value & 8 == 0 {
                        "lane:a|f"
                    } else {
                        "lane:b|f"
                    },
                );
            }
            1 => {
                let _ = scheduler.shift();
            }
            2 => {
                registry.register(value.max(1), index as f64);
            }
            3 => {
                registry.wake(value.max(1));
            }
            4 => {
                let _ = registry.drain_wakeup();
            }
            5 => {
                let _ = timers.schedule(value, value >> 8, u64::from(value));
            }
            6 => {
                let _ = timers.advance(u64::from(value));
            }
            _ => {
                if let Some(id) = slab.insert(value) {
                    ids.push(id);
                }
                if ids.len() > 8 {
                    let id = ids.remove(0);
                    slab.remove(id);
                    let _ = slab.get(id);
                }
            }
        }
        assert!(scheduler.len() <= scheduler.capacity());
        assert_eq!(registry.wake_queue_len(), registry.stats().wake_queue_len);
        assert_eq!(slab.len(), slab.stats().live);
    }
});
