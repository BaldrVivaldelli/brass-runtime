use crate::{
    validate_node_references, AbiError, Node, NodeId, Program, EVENT_WORDS, MAX_PROGRAM_NODES,
    NONE_U32, OP_ASYNC, OP_FAIL, OP_FLAT_MAP, OP_FOLD, OP_FORK, OP_HOST_ACTION, OP_SUCCEED,
    OP_SYNC,
};

pub type VmFiberId = u32;
pub type RefId = u32;

pub const EVENT_CONTINUE: u32 = 0;
pub const EVENT_DONE: u32 = 1;
pub const EVENT_FAILED: u32 = 2;
pub const EVENT_INTERRUPTED: u32 = 3;
pub const EVENT_INVOKE_SYNC: u32 = 4;
pub const EVENT_INVOKE_ASYNC: u32 = 5;
pub const EVENT_INVOKE_FLAT_MAP: u32 = 6;
pub const EVENT_INVOKE_FOLD_FAILURE: u32 = 7;
pub const EVENT_INVOKE_FOLD_SUCCESS: u32 = 8;
pub const EVENT_INVOKE_FORK: u32 = 9;
pub const EVENT_INVOKE_HOST_ACTION: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
pub enum FiberMachineStatus {
    Running,
    Suspended,
    Done,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmEvent {
    Continue {
        fiber_id: VmFiberId,
    },
    Done {
        fiber_id: VmFiberId,
        value_ref: RefId,
    },
    Failed {
        fiber_id: VmFiberId,
        error_ref: RefId,
    },
    Interrupted {
        fiber_id: VmFiberId,
        reason_ref: RefId,
    },
    InvokeSync {
        fiber_id: VmFiberId,
        fn_ref: RefId,
    },
    InvokeAsync {
        fiber_id: VmFiberId,
        register_ref: RefId,
    },
    InvokeFlatMap {
        fiber_id: VmFiberId,
        fn_ref: RefId,
        value_ref: RefId,
    },
    InvokeFoldFailure {
        fiber_id: VmFiberId,
        fn_ref: RefId,
        error_ref: RefId,
    },
    InvokeFoldSuccess {
        fiber_id: VmFiberId,
        fn_ref: RefId,
        value_ref: RefId,
    },
    InvokeFork {
        fiber_id: VmFiberId,
        effect_ref: RefId,
        scope_id: Option<u32>,
    },
    InvokeHostAction {
        fiber_id: VmFiberId,
        action_ref: RefId,
        decode_ref: Option<RefId>,
    },
}

impl VmEvent {
    pub const fn fiber_id(self) -> VmFiberId {
        match self {
            Self::Continue { fiber_id }
            | Self::Done { fiber_id, .. }
            | Self::Failed { fiber_id, .. }
            | Self::Interrupted { fiber_id, .. }
            | Self::InvokeSync { fiber_id, .. }
            | Self::InvokeAsync { fiber_id, .. }
            | Self::InvokeFlatMap { fiber_id, .. }
            | Self::InvokeFoldFailure { fiber_id, .. }
            | Self::InvokeFoldSuccess { fiber_id, .. }
            | Self::InvokeFork { fiber_id, .. }
            | Self::InvokeHostAction { fiber_id, .. } => fiber_id,
        }
    }

    pub const fn words(self) -> [u32; EVENT_WORDS] {
        match self {
            Self::Continue { fiber_id } => [EVENT_CONTINUE, fiber_id, 0, 0, 0],
            Self::Done {
                fiber_id,
                value_ref,
            } => [EVENT_DONE, fiber_id, value_ref, 0, 0],
            Self::Failed {
                fiber_id,
                error_ref,
            } => [EVENT_FAILED, fiber_id, error_ref, 0, 0],
            Self::Interrupted {
                fiber_id,
                reason_ref,
            } => [EVENT_INTERRUPTED, fiber_id, reason_ref, 0, 0],
            Self::InvokeSync { fiber_id, fn_ref } => [EVENT_INVOKE_SYNC, fiber_id, fn_ref, 0, 0],
            Self::InvokeAsync {
                fiber_id,
                register_ref,
            } => [EVENT_INVOKE_ASYNC, fiber_id, register_ref, 0, 0],
            Self::InvokeFlatMap {
                fiber_id,
                fn_ref,
                value_ref,
            } => [EVENT_INVOKE_FLAT_MAP, fiber_id, fn_ref, value_ref, 0],
            Self::InvokeFoldFailure {
                fiber_id,
                fn_ref,
                error_ref,
            } => [EVENT_INVOKE_FOLD_FAILURE, fiber_id, fn_ref, error_ref, 0],
            Self::InvokeFoldSuccess {
                fiber_id,
                fn_ref,
                value_ref,
            } => [EVENT_INVOKE_FOLD_SUCCESS, fiber_id, fn_ref, value_ref, 0],
            Self::InvokeFork {
                fiber_id,
                effect_ref,
                scope_id,
            } => [
                EVENT_INVOKE_FORK,
                fiber_id,
                effect_ref,
                match scope_id {
                    Some(value) => value,
                    None => NONE_U32,
                },
                0,
            ],
            Self::InvokeHostAction {
                fiber_id,
                action_ref,
                decode_ref,
            } => [
                EVENT_INVOKE_HOST_ACTION,
                fiber_id,
                action_ref,
                match decode_ref {
                    Some(value) => value,
                    None => NONE_U32,
                },
                0,
            ],
        }
    }
}

/// Host-independent deterministic fiber transition machine. It never executes
/// a callback: host work is represented only as `VmEvent` plus opaque refs.
pub struct FiberMachine {
    fiber_id: VmFiberId,
    program: Program,
    current: Option<NodeId>,
    stack: Vec<Frame>,
    status: FiberMachineStatus,
    last_event: Option<VmEvent>,
}

impl FiberMachine {
    pub fn new(fiber_id: VmFiberId, program: Program) -> Self {
        let root = program.root;
        Self {
            fiber_id,
            program,
            current: Some(root),
            stack: Vec::new(),
            status: FiberMachineStatus::Running,
            last_event: None,
        }
    }

    pub const fn status(&self) -> FiberMachineStatus {
        self.status
    }

    pub const fn node_count(&self) -> usize {
        self.program.nodes.len()
    }

    pub fn poll(&mut self) -> VmEvent {
        if self.status == FiberMachineStatus::Suspended {
            return self.last_event.unwrap_or(VmEvent::Continue {
                fiber_id: self.fiber_id,
            });
        }
        self.step()
    }

    pub fn provide_value(&mut self, value_ref: RefId) -> VmEvent {
        self.status = FiberMachineStatus::Running;
        self.last_event = None;
        self.success(value_ref)
    }

    pub fn provide_error(&mut self, error_ref: RefId) -> VmEvent {
        self.status = FiberMachineStatus::Running;
        self.last_event = None;
        self.failure(error_ref)
    }

    pub fn provide_effect(&mut self, root: NodeId, nodes: Vec<Node>) -> Result<VmEvent, AbiError> {
        let total = self
            .program
            .nodes
            .len()
            .checked_add(nodes.len())
            .ok_or(AbiError::NodeCountOverflow)?;
        if total > MAX_PROGRAM_NODES {
            return Err(AbiError::NodeCountLimit {
                maximum: MAX_PROGRAM_NODES,
                actual: total,
            });
        }
        if root as usize >= total {
            return Err(AbiError::InvalidRoot {
                root,
                node_count: total,
            });
        }
        validate_node_references(&nodes, total)?;
        self.program.nodes.extend(nodes);
        self.current = Some(root);
        self.status = FiberMachineStatus::Running;
        self.last_event = None;
        Ok(self.step())
    }

    pub fn interrupt(&mut self, reason_ref: RefId) -> VmEvent {
        self.status = FiberMachineStatus::Interrupted;
        self.current = None;
        self.stack.clear();
        let event = VmEvent::Interrupted {
            fiber_id: self.fiber_id,
            reason_ref,
        };
        self.last_event = Some(event);
        event
    }

    fn step(&mut self) -> VmEvent {
        loop {
            if self.status == FiberMachineStatus::Interrupted {
                return self.last_event.unwrap_or(VmEvent::Interrupted {
                    fiber_id: self.fiber_id,
                    reason_ref: 0,
                });
            }
            let Some(current) = self.current else {
                return self.mark_failed(0);
            };
            let Some(node) = self.program.nodes.get(current as usize).copied() else {
                return self.mark_failed(0);
            };
            match node.tag {
                OP_SUCCEED => return self.success(node.a),
                OP_FAIL => return self.failure(node.a),
                OP_SYNC => {
                    return self.suspend(VmEvent::InvokeSync {
                        fiber_id: self.fiber_id,
                        fn_ref: node.a,
                    })
                }
                OP_ASYNC => {
                    return self.suspend(VmEvent::InvokeAsync {
                        fiber_id: self.fiber_id,
                        register_ref: node.a,
                    })
                }
                OP_HOST_ACTION => {
                    return self.suspend(VmEvent::InvokeHostAction {
                        fiber_id: self.fiber_id,
                        action_ref: node.a,
                        decode_ref: (node.b != NONE_U32).then_some(node.b),
                    })
                }
                OP_FORK => {
                    return self.suspend(VmEvent::InvokeFork {
                        fiber_id: self.fiber_id,
                        effect_ref: node.a,
                        scope_id: (node.b != NONE_U32).then_some(node.b),
                    })
                }
                OP_FLAT_MAP => {
                    self.stack.push(Frame::SuccessCont { fn_ref: node.b });
                    self.current = Some(node.a);
                }
                OP_FOLD => {
                    self.stack.push(Frame::FoldCont {
                        on_failure_ref: node.b,
                        on_success_ref: node.c,
                    });
                    self.current = Some(node.a);
                }
                _ => return self.mark_failed(0),
            }
        }
    }

    fn success(&mut self, value_ref: RefId) -> VmEvent {
        let Some(frame) = self.stack.pop() else {
            return self.mark_done(value_ref);
        };
        match frame {
            Frame::SuccessCont { fn_ref } => self.suspend(VmEvent::InvokeFlatMap {
                fiber_id: self.fiber_id,
                fn_ref,
                value_ref,
            }),
            Frame::FoldCont { on_success_ref, .. } => self.suspend(VmEvent::InvokeFoldSuccess {
                fiber_id: self.fiber_id,
                fn_ref: on_success_ref,
                value_ref,
            }),
        }
    }

    fn failure(&mut self, error_ref: RefId) -> VmEvent {
        while let Some(frame) = self.stack.pop() {
            if let Frame::FoldCont { on_failure_ref, .. } = frame {
                return self.suspend(VmEvent::InvokeFoldFailure {
                    fiber_id: self.fiber_id,
                    fn_ref: on_failure_ref,
                    error_ref,
                });
            }
        }
        self.mark_failed(error_ref)
    }

    fn suspend(&mut self, event: VmEvent) -> VmEvent {
        self.status = FiberMachineStatus::Suspended;
        self.last_event = Some(event);
        event
    }

    fn mark_done(&mut self, value_ref: RefId) -> VmEvent {
        self.status = FiberMachineStatus::Done;
        self.current = None;
        let event = VmEvent::Done {
            fiber_id: self.fiber_id,
            value_ref,
        };
        self.last_event = Some(event);
        event
    }

    fn mark_failed(&mut self, error_ref: RefId) -> VmEvent {
        self.status = FiberMachineStatus::Failed;
        self.current = None;
        let event = VmEvent::Failed {
            fiber_id: self.fiber_id,
            error_ref,
        };
        self.last_event = Some(event);
        event
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OP_FLAT_MAP, OP_SUCCEED};

    #[test]
    fn suspends_for_host_continuations_and_resumes_with_a_patch() {
        let program = Program::new(
            1,
            vec![
                Node::new(OP_SUCCEED, 10, 0, 0),
                Node::new(OP_FLAT_MAP, 0, 20, 0),
            ],
        )
        .expect("valid program");
        let mut vm = FiberMachine::new(7, program);
        assert_eq!(
            vm.poll(),
            VmEvent::InvokeFlatMap {
                fiber_id: 7,
                fn_ref: 20,
                value_ref: 10,
            }
        );
        assert_eq!(
            vm.provide_effect(2, vec![Node::new(OP_SUCCEED, 30, 0, 0)]),
            Ok(VmEvent::Done {
                fiber_id: 7,
                value_ref: 30,
            })
        );
    }
}
