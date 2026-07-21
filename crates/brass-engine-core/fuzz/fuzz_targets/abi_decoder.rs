#![no_main]

use brass_engine_core::{decode_patch_nodes_words, decode_program_words, MAX_PROGRAM_WORDS};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if data.len() / 4 > MAX_PROGRAM_WORDS {
        return;
    }
    let words: Vec<u32> = data
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    let _ = decode_program_words(&words);
    let _ = decode_patch_nodes_words(&words);
});
