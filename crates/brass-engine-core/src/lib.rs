//! Portable contracts shared by the Brass TypeScript/WASM runtime and native
//! services. This crate deliberately has no host, I/O, permission, JavaScript,
//! or `wasm-bindgen` dependencies.

use std::error::Error;
use std::fmt::{Display, Formatter};

mod registry;
mod scheduler;
mod slab;
mod timer;
mod vm;

pub use registry::*;
pub use scheduler::*;
pub use slab::*;
pub use timer::*;
pub use vm::*;

pub type NodeId = u32;

pub const ABI_VERSION: u32 = 1;
pub const ABI_MIN_COMPATIBLE_VERSION: u32 = 1;
pub const NONE_U32: u32 = u32::MAX;
pub const NODE_WORDS: usize = 4;
pub const PROGRAM_HEADER_WORDS: usize = 3;
pub const EVENT_WORDS: usize = 5;

/// One million nodes bounds a single crossing to roughly 16 MiB. Callers are
/// expected to use much smaller batches; this is the hard allocation guard.
pub const MAX_PROGRAM_NODES: usize = 1_048_576;
pub const MAX_PROGRAM_WORDS: usize = PROGRAM_HEADER_WORDS + MAX_PROGRAM_NODES * NODE_WORDS;
pub const MAX_PATCH_WORDS: usize = 1 + MAX_PROGRAM_NODES * NODE_WORDS;
pub const MAX_EVENT_BATCH: u32 = 65_536;

pub const OP_SUCCEED: u32 = 0;
pub const OP_FAIL: u32 = 1;
pub const OP_SYNC: u32 = 2;
pub const OP_ASYNC: u32 = 3;
pub const OP_FLAT_MAP: u32 = 4;
pub const OP_FOLD: u32 = 5;
pub const OP_FORK: u32 = 6;
pub const OP_HOST_ACTION: u32 = 7;

pub const CAP_BINARY_ABI: u32 = 1 << 0;
pub const CAP_ZERO_COPY: u32 = 1 << 1;
pub const CAP_BATCHED_EVENTS: u32 = 1 << 2;
pub const CAP_METRICS_SNAPSHOT: u32 = 1 << 3;
pub const ENGINE_CAPABILITIES: u32 =
    CAP_BINARY_ABI | CAP_ZERO_COPY | CAP_BATCHED_EVENTS | CAP_METRICS_SNAPSHOT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineHandshake {
    pub abi_version: u32,
    pub min_compatible_abi_version: u32,
    pub capabilities: u32,
    pub max_program_words: u32,
    pub max_patch_words: u32,
    pub max_event_batch: u32,
}

impl Default for EngineHandshake {
    fn default() -> Self {
        Self {
            abi_version: ABI_VERSION,
            min_compatible_abi_version: ABI_MIN_COMPATIBLE_VERSION,
            capabilities: ENGINE_CAPABILITIES,
            max_program_words: MAX_PROGRAM_WORDS as u32,
            max_patch_words: MAX_PATCH_WORDS as u32,
            max_event_batch: MAX_EVENT_BATCH,
        }
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Node {
    pub tag: u32,
    pub a: u32,
    pub b: u32,
    pub c: u32,
}

impl Node {
    pub const fn new(tag: u32, a: u32, b: u32, c: u32) -> Self {
        Self { tag, a, b, c }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub root: NodeId,
    pub nodes: Vec<Node>,
}

impl Program {
    pub fn new(root: NodeId, nodes: Vec<Node>) -> Result<Self, AbiError> {
        validate_program(root, &nodes)?;
        Ok(Self { root, nodes })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbiError {
    BufferTooShort {
        minimum: usize,
        actual: usize,
    },
    BufferTooLarge {
        maximum: usize,
        actual: usize,
    },
    UnsupportedVersion {
        requested: u32,
        supported: u32,
    },
    NodeCountOverflow,
    NodeCountLimit {
        maximum: usize,
        actual: usize,
    },
    TrailingOrMissingWords {
        expected: usize,
        actual: usize,
    },
    EmptyProgram,
    InvalidRoot {
        root: NodeId,
        node_count: usize,
    },
    UnknownOpcode {
        tag: u32,
        index: usize,
    },
    InvalidNodeReference {
        index: usize,
        target: NodeId,
        node_count: usize,
    },
}

impl Display for AbiError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferTooShort { minimum, actual } => {
                write!(
                    formatter,
                    "ABI buffer too short: minimum {minimum} words, got {actual}"
                )
            }
            Self::BufferTooLarge { maximum, actual } => {
                write!(
                    formatter,
                    "ABI buffer too large: maximum {maximum} words, got {actual}"
                )
            }
            Self::UnsupportedVersion {
                requested,
                supported,
            } => write!(
                formatter,
                "unsupported ABI version {requested}; this engine supports {supported}"
            ),
            Self::NodeCountOverflow => formatter.write_str("ABI node count overflow"),
            Self::NodeCountLimit { maximum, actual } => {
                write!(
                    formatter,
                    "ABI node count exceeds limit: maximum {maximum}, got {actual}"
                )
            }
            Self::TrailingOrMissingWords { expected, actual } => write!(
                formatter,
                "ABI node buffer length mismatch: expected {expected} words, got {actual}"
            ),
            Self::EmptyProgram => formatter.write_str("ABI program must contain at least one node"),
            Self::InvalidRoot { root, node_count } => {
                write!(formatter, "ABI root {root} is outside {node_count} nodes")
            }
            Self::UnknownOpcode { tag, index } => {
                write!(formatter, "unknown ABI opcode {tag} at node {index}")
            }
            Self::InvalidNodeReference {
                index,
                target,
                node_count,
            } => write!(
                formatter,
                "ABI node {index} references node {target} outside {node_count} nodes"
            ),
        }
    }
}

impl Error for AbiError {}

pub fn decode_program_words(words: &[u32]) -> Result<Program, AbiError> {
    if words.len() < PROGRAM_HEADER_WORDS {
        return Err(AbiError::BufferTooShort {
            minimum: PROGRAM_HEADER_WORDS,
            actual: words.len(),
        });
    }
    if words.len() > MAX_PROGRAM_WORDS {
        return Err(AbiError::BufferTooLarge {
            maximum: MAX_PROGRAM_WORDS,
            actual: words.len(),
        });
    }
    if words[0] != ABI_VERSION {
        return Err(AbiError::UnsupportedVersion {
            requested: words[0],
            supported: ABI_VERSION,
        });
    }
    let root = words[1];
    let count = usize::try_from(words[2]).map_err(|_| AbiError::NodeCountOverflow)?;
    let nodes = decode_nodes_body(&words[PROGRAM_HEADER_WORDS..], count)?;
    Program::new(root, nodes)
}

pub fn decode_patch_nodes_words(words: &[u32]) -> Result<Vec<Node>, AbiError> {
    if words.is_empty() {
        return Ok(Vec::new());
    }
    if words.len() > MAX_PATCH_WORDS {
        return Err(AbiError::BufferTooLarge {
            maximum: MAX_PATCH_WORDS,
            actual: words.len(),
        });
    }
    let count = usize::try_from(words[0]).map_err(|_| AbiError::NodeCountOverflow)?;
    decode_nodes_body(&words[1..], count)
}

pub fn validate_program(root: NodeId, nodes: &[Node]) -> Result<(), AbiError> {
    if nodes.is_empty() {
        return Err(AbiError::EmptyProgram);
    }
    if nodes.len() > MAX_PROGRAM_NODES {
        return Err(AbiError::NodeCountLimit {
            maximum: MAX_PROGRAM_NODES,
            actual: nodes.len(),
        });
    }
    if root as usize >= nodes.len() {
        return Err(AbiError::InvalidRoot {
            root,
            node_count: nodes.len(),
        });
    }
    validate_node_references(nodes, nodes.len())
}

/// Validate node-to-node references after a patch has been appended. Patch
/// references are absolute, so `total_node_count` includes existing nodes.
pub fn validate_node_references(nodes: &[Node], total_node_count: usize) -> Result<(), AbiError> {
    for (index, node) in nodes.iter().enumerate() {
        validate_opcode(node.tag, index)?;
        if matches!(node.tag, OP_FLAT_MAP | OP_FOLD) && node.a as usize >= total_node_count {
            return Err(AbiError::InvalidNodeReference {
                index,
                target: node.a,
                node_count: total_node_count,
            });
        }
    }
    Ok(())
}

fn decode_nodes_body(words: &[u32], count: usize) -> Result<Vec<Node>, AbiError> {
    if count > MAX_PROGRAM_NODES {
        return Err(AbiError::NodeCountLimit {
            maximum: MAX_PROGRAM_NODES,
            actual: count,
        });
    }
    let expected = count
        .checked_mul(NODE_WORDS)
        .ok_or(AbiError::NodeCountOverflow)?;
    if words.len() != expected {
        return Err(AbiError::TrailingOrMissingWords {
            expected,
            actual: words.len(),
        });
    }
    let mut nodes = Vec::with_capacity(count);
    for (index, chunk) in words.chunks_exact(NODE_WORDS).enumerate() {
        validate_opcode(chunk[0], index)?;
        nodes.push(Node::new(chunk[0], chunk[1], chunk[2], chunk[3]));
    }
    Ok(nodes)
}

fn validate_opcode(tag: u32, index: usize) -> Result<(), AbiError> {
    if matches!(
        tag,
        OP_SUCCEED
            | OP_FAIL
            | OP_SYNC
            | OP_ASYNC
            | OP_FLAT_MAP
            | OP_FOLD
            | OP_FORK
            | OP_HOST_ACTION
    ) {
        Ok(())
    } else {
        Err(AbiError::UnknownOpcode { tag, index })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn succeed_program() -> Vec<u32> {
        vec![ABI_VERSION, 0, 1, OP_SUCCEED, 7, 0, 0]
    }

    #[test]
    fn decodes_a_valid_program_without_host_dependencies() {
        let program = decode_program_words(&succeed_program()).expect("valid fixture");
        assert_eq!(program.root, 0);
        assert_eq!(program.nodes, vec![Node::new(OP_SUCCEED, 7, 0, 0)]);
    }

    #[test]
    fn rejects_unknown_versions_and_invalid_roots() {
        let mut future = succeed_program();
        future[0] = ABI_VERSION + 1;
        assert!(matches!(
            decode_program_words(&future),
            Err(AbiError::UnsupportedVersion { .. })
        ));

        let mut bad_root = succeed_program();
        bad_root[1] = 1;
        assert!(matches!(
            decode_program_words(&bad_root),
            Err(AbiError::InvalidRoot { .. })
        ));
    }

    #[test]
    fn rejects_length_mismatches_and_invalid_node_links() {
        let mut trailing = succeed_program();
        trailing.push(0);
        assert!(matches!(
            decode_program_words(&trailing),
            Err(AbiError::TrailingOrMissingWords { .. })
        ));

        let invalid_link = vec![ABI_VERSION, 0, 1, OP_FLAT_MAP, 9, 1, 0];
        assert!(matches!(
            decode_program_words(&invalid_link),
            Err(AbiError::InvalidNodeReference { .. })
        ));
    }

    #[test]
    fn exposes_a_stable_handshake() {
        assert_eq!(
            EngineHandshake::default(),
            EngineHandshake {
                abi_version: 1,
                min_compatible_abi_version: 1,
                capabilities: 15,
                max_program_words: MAX_PROGRAM_WORDS as u32,
                max_patch_words: MAX_PATCH_WORDS as u32,
                max_event_batch: MAX_EVENT_BATCH,
            }
        );
    }
}
