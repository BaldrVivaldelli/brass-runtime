import type { EngineEvent } from "./types";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "./opcodes";

export const ABI_VERSION = 1;
export const EVENT_WORDS = 5;
export const NONE_U32 = 0xffffffff;

export const enum OpcodeTagCode {
  Succeed = 0,
  Fail = 1,
  Sync = 2,
  Async = 3,
  FlatMap = 4,
  Fold = 5,
  Fork = 6,
  HostAction = 7,
}

export const enum EventKindCode {
  Continue = 0,
  Done = 1,
  Failed = 2,
  Interrupted = 3,
  InvokeSync = 4,
  InvokeAsync = 5,
  InvokeFlatMap = 6,
  InvokeFoldFailure = 7,
  InvokeFoldSuccess = 8,
  InvokeFork = 9,
  InvokeHostAction = 10,
}

export function encodeOpcodeProgram(program: OpcodeProgram): Uint32Array {
  const out = new Uint32Array(3 + program.nodes.length * 4);
  out[0] = ABI_VERSION;
  out[1] = program.root >>> 0;
  out[2] = program.nodes.length >>> 0;
  writeNodes(out, 3, program.nodes);
  return out;
}

export function encodeOpcodeNodes(nodes: readonly OpcodeNode[]): Uint32Array {
  const out = new Uint32Array(1 + nodes.length * 4);
  out[0] = nodes.length >>> 0;
  writeNodes(out, 1, nodes);
  return out;
}

function writeNodes(out: Uint32Array, offset: number, nodes: readonly OpcodeNode[]): void {
  let i = offset;
  for (const node of nodes) {
    switch (node.tag) {
      case "Succeed":
        out[i++] = OpcodeTagCode.Succeed;
        out[i++] = node.valueRef >>> 0;
        out[i++] = 0;
        out[i++] = 0;
        break;
      case "Fail":
        out[i++] = OpcodeTagCode.Fail;
        out[i++] = node.errorRef >>> 0;
        out[i++] = 0;
        out[i++] = 0;
        break;
      case "Sync":
        out[i++] = OpcodeTagCode.Sync;
        out[i++] = node.fnRef >>> 0;
        out[i++] = 0;
        out[i++] = 0;
        break;
      case "Async":
        out[i++] = OpcodeTagCode.Async;
        out[i++] = node.registerRef >>> 0;
        out[i++] = 0;
        out[i++] = 0;
        break;
      case "FlatMap":
        out[i++] = OpcodeTagCode.FlatMap;
        out[i++] = node.first >>> 0;
        out[i++] = node.fnRef >>> 0;
        out[i++] = 0;
        break;
      case "Fold":
        out[i++] = OpcodeTagCode.Fold;
        out[i++] = node.first >>> 0;
        out[i++] = node.onFailureRef >>> 0;
        out[i++] = node.onSuccessRef >>> 0;
        break;
      case "Fork":
        out[i++] = OpcodeTagCode.Fork;
        out[i++] = node.effectRef >>> 0;
        out[i++] = node.scopeId === undefined ? NONE_U32 : node.scopeId >>> 0;
        out[i++] = 0;
        break;
      case "HostAction":
        out[i++] = OpcodeTagCode.HostAction;
        out[i++] = node.actionRef >>> 0;
        out[i++] = node.decodeRef === undefined ? NONE_U32 : node.decodeRef >>> 0;
        out[i++] = 0;
        break;
    }
  }
}

export function decodeEvent(words: ArrayLike<number>, offset = 0): EngineEvent {
  const kind = words[offset] >>> 0;
  const fiberId = words[offset + 1] as FiberId;
  const a = words[offset + 2] >>> 0;
  const b = words[offset + 3] >>> 0;
  const c = words[offset + 4] >>> 0;

  switch (kind) {
    case EventKindCode.Continue:
      return { kind: "Continue", fiberId };
    case EventKindCode.Done:
      return { kind: "Done", fiberId, valueRef: a as RefId };
    case EventKindCode.Failed:
      return { kind: "Failed", fiberId, errorRef: a as RefId };
    case EventKindCode.Interrupted:
      return { kind: "Interrupted", fiberId, reasonRef: a as RefId };
    case EventKindCode.InvokeSync:
      return { kind: "InvokeSync", fiberId, fnRef: a as RefId };
    case EventKindCode.InvokeAsync:
      return { kind: "InvokeAsync", fiberId, registerRef: a as RefId };
    case EventKindCode.InvokeFlatMap:
      return { kind: "InvokeFlatMap", fiberId, fnRef: a as RefId, valueRef: b as RefId };
    case EventKindCode.InvokeFoldFailure:
      return { kind: "InvokeFoldFailure", fiberId, fnRef: a as RefId, errorRef: b as RefId };
    case EventKindCode.InvokeFoldSuccess:
      return { kind: "InvokeFoldSuccess", fiberId, fnRef: a as RefId, valueRef: b as RefId };
    case EventKindCode.InvokeFork:
      return c === NONE_U32 || b === NONE_U32
        ? { kind: "InvokeFork", fiberId, effectRef: a as RefId }
        : { kind: "InvokeFork", fiberId, effectRef: a as RefId, scopeId: b };
    case EventKindCode.InvokeHostAction:
      return b === NONE_U32
        ? { kind: "InvokeHostAction", fiberId, actionRef: a as RefId }
        : { kind: "InvokeHostAction", fiberId, actionRef: a as RefId, decodeRef: b as RefId };
    default:
      return { kind: "Failed", fiberId, errorRef: 0 };
  }
}

export function decodeEventBatch(words: ArrayLike<number> | null | undefined): EngineEvent[] {
  if (!words || words.length === 0) return [];
  const count = words[0] >>> 0;
  const events: EngineEvent[] = [];
  const max = Math.min(count, Math.floor((words.length - 1) / EVENT_WORDS));
  for (let i = 0; i < max; i++) {
    events.push(decodeEvent(words, 1 + i * EVENT_WORDS));
  }
  return events;
}
