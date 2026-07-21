pub type SlabId = u32;
const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const GENERATION_SHIFT: u32 = INDEX_BITS;
const GENERATION_MASK: u32 = (1 << (32 - INDEX_BITS)) - 1;
pub const MAX_SLAB_ENTRIES: usize = INDEX_MASK as usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlabStats {
    pub live: usize,
    pub capacity: usize,
    pub allocated: u64,
    pub reused: u64,
    pub released: u64,
    pub stale_reads: u64,
}

struct Slot<T> {
    generation: u32,
    value: Option<T>,
}

pub struct GenerationalSlab<T> {
    slots: Vec<Slot<T>>,
    free: Vec<usize>,
    stats: SlabStats,
}

impl<T> Default for GenerationalSlab<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> GenerationalSlab<T> {
    pub fn new() -> Self {
        Self {
            slots: vec![Slot {
                generation: 0,
                value: None,
            }],
            free: Vec::new(),
            stats: SlabStats {
                live: 0,
                capacity: 0,
                allocated: 0,
                reused: 0,
                released: 0,
                stale_reads: 0,
            },
        }
    }
    pub fn insert(&mut self, value: T) -> Option<SlabId> {
        let index = self.free.pop().unwrap_or(self.slots.len());
        if index > MAX_SLAB_ENTRIES {
            return None;
        }
        if index == self.slots.len() {
            self.slots.push(Slot {
                generation: 0,
                value: None,
            });
            self.stats.capacity += 1;
        } else {
            self.stats.reused += 1;
        }
        let slot = &mut self.slots[index];
        slot.generation = ((slot.generation + 1) & GENERATION_MASK).max(1);
        let id = encode_id(index as u32, slot.generation);
        slot.value = Some(value);
        self.stats.live += 1;
        self.stats.allocated += 1;
        Some(id)
    }
    pub fn get(&mut self, id: SlabId) -> Option<&T> {
        let (index, generation) = decode_id(id);
        let valid = self
            .slots
            .get(index)
            .is_some_and(|slot| slot.generation == generation && slot.value.is_some());
        if !valid {
            self.stats.stale_reads += 1;
            return None;
        }
        self.slots[index].value.as_ref()
    }
    pub fn get_mut(&mut self, id: SlabId) -> Option<&mut T> {
        let (index, generation) = decode_id(id);
        let valid = self
            .slots
            .get(index)
            .is_some_and(|slot| slot.generation == generation && slot.value.is_some());
        if !valid {
            self.stats.stale_reads += 1;
            return None;
        }
        self.slots[index].value.as_mut()
    }
    pub fn remove(&mut self, id: SlabId) -> bool {
        let (index, generation) = decode_id(id);
        let Some(slot) = self.slots.get_mut(index) else {
            self.stats.stale_reads += 1;
            return false;
        };
        if slot.generation != generation || slot.value.is_none() {
            self.stats.stale_reads += 1;
            return false;
        }
        slot.value = None;
        self.free.push(index);
        self.stats.live = self.stats.live.saturating_sub(1);
        self.stats.released += 1;
        true
    }
    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.slots.iter().filter_map(|slot| slot.value.as_ref())
    }
    pub const fn len(&self) -> usize {
        self.stats.live
    }
    pub const fn is_empty(&self) -> bool {
        self.stats.live == 0
    }
    pub const fn stats(&self) -> SlabStats {
        self.stats
    }
}

const fn encode_id(index: u32, generation: u32) -> SlabId {
    ((generation & GENERATION_MASK) << GENERATION_SHIFT) | (index & INDEX_MASK)
}
const fn decode_id(id: SlabId) -> (usize, u32) {
    (
        (id & INDEX_MASK) as usize,
        (id >> GENERATION_SHIFT) & GENERATION_MASK,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_ids_never_alias_reused_slots() {
        let mut slab = GenerationalSlab::new();
        for value in 0..10_000u32 {
            let old = slab.insert(value).expect("capacity");
            assert_eq!(slab.get(old), Some(&value));
            assert!(slab.remove(old));
            let new = slab.insert(value + 1).expect("reuse");
            assert_ne!(old, new);
            assert!(slab.get(old).is_none());
            assert_eq!(slab.get(new), Some(&(value + 1)));
            assert!(slab.remove(new));
        }
        assert_eq!(slab.len(), 0);
        assert!(slab.stats().reused > 0);
    }
}
