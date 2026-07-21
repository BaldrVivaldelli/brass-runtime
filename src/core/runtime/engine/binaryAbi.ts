import type { EngineEvent } from "./types";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "./opcodes";
import {
  assertAbiWordLimit,
  ENGINE_ABI_LIMITS,
  ENGINE_ABI_VERSION,
} from "./abiContract";

export const ABI_VERSION = ENGINE_ABI_VERSION;
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
  if (program.version !== ABI_VERSION) {
    throw new Error(`Unsupported Brass opcode program ABI ${String(program.version)}`);
  }
  if (program.nodes.length === 0 || program.nodes.length > ENGINE_ABI_LIMITS.maxProgramNodes) {
    throw new Error(`Brass opcode program must contain 1-${ENGINE_ABI_LIMITS.maxProgramNodes} nodes`);
  }
  if (!Number.isSafeInteger(program.root) || program.root < 0 || program.root >= program.nodes.length) {
    throw new Error(`Brass opcode root ${String(program.root)} is outside ${program.nodes.length} nodes`);
  }
  const wordLength = 3 + program.nodes.length * 4;
  assertAbiWordLimit("program", wordLength);
  const out = new Uint32Array(wordLength);
  out[0] = ABI_VERSION;
  out[1] = program.root >>> 0;
  out[2] = program.nodes.length >>> 0;
  writeNodes(out, 3, program.nodes);
  return out;
}

export function encodeOpcodeNodes(nodes: readonly OpcodeNode[]): Uint32Array {
  if (nodes.length > ENGINE_ABI_LIMITS.maxProgramNodes) {
    throw new Error(`Brass opcode patch exceeds ${ENGINE_ABI_LIMITS.maxProgramNodes} nodes`);
  }
  const wordLength = 1 + nodes.length * 4;
  assertAbiWordLimit("patch", wordLength);
  const out = new Uint32Array(wordLength);
  out[0] = nodes.length >>> 0;
  writeNodes(out, 1, nodes);
  return out;
}

export function decodeOpcodeProgram(words: ArrayLike<number>): OpcodeProgram {
  assertAbiWordLimit("program", words.length);
  if (words.length < 3) throw new Error("Brass opcode program header is truncated");
  const version = words[0] >>> 0;
  if (version !== ABI_VERSION) {
    throw new Error(`Unsupported Brass opcode program ABI ${String(version)}`);
  }
  const root = words[1] >>> 0;
  const count = words[2] >>> 0;
  if (count === 0 || count > ENGINE_ABI_LIMITS.maxProgramNodes) {
    throw new Error(`Brass opcode program must contain 1-${ENGINE_ABI_LIMITS.maxProgramNodes} nodes`);
  }
  const expected = 3 + count * 4;
  if (words.length !== expected) {
    throw new Error(`Brass opcode program length mismatch: expected ${expected}, got ${words.length}`);
  }
  if (root >= count) throw new Error(`Brass opcode root ${root} is outside ${count} nodes`);
  const nodes = readNodes(words, 3, count);
  validateNodeReferences(nodes, count);
  return { version, root: root as NodeId, nodes };
}

export function decodeOpcodeNodes(words: ArrayLike<number>): OpcodeNode[] {
  assertAbiWordLimit("patch", words.length);
  if (words.length < 1) throw new Error("Brass opcode patch header is truncated");
  const count = words[0] >>> 0;
  if (count > ENGINE_ABI_LIMITS.maxProgramNodes) {
    throw new Error(`Brass opcode patch exceeds ${ENGINE_ABI_LIMITS.maxProgramNodes} nodes`);
  }
  const expected = 1 + count * 4;
  if (words.length !== expected) {
    throw new Error(`Brass opcode patch length mismatch: expected ${expected}, got ${words.length}`);
  }
  return readNodes(words, 1, count);
}

function readNodes(words: ArrayLike<number>, offset: number, count: number): OpcodeNode[] {
  const nodes: OpcodeNode[] = [];
  let index = offset;
  for (let nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
    const tag = words[index++] >>> 0;
    const a = words[index++] >>> 0;
    const b = words[index++] >>> 0;
    const c = words[index++] >>> 0;
    switch (tag) {
      case OpcodeTagCode.Succeed:
        nodes.push({ tag: "Succeed", valueRef: a as RefId });
        break;
      case OpcodeTagCode.Fail:
        nodes.push({ tag: "Fail", errorRef: a as RefId });
        break;
      case OpcodeTagCode.Sync:
        nodes.push({ tag: "Sync", fnRef: a as RefId });
        break;
      case OpcodeTagCode.Async:
        nodes.push({ tag: "Async", registerRef: a as RefId });
        break;
      case OpcodeTagCode.FlatMap:
        nodes.push({ tag: "FlatMap", first: a as NodeId, fnRef: b as RefId });
        break;
      case OpcodeTagCode.Fold:
        nodes.push({
          tag: "Fold",
          first: a as NodeId,
          onFailureRef: b as RefId,
          onSuccessRef: c as RefId,
        });
        break;
      case OpcodeTagCode.Fork:
        nodes.push(b === NONE_U32
          ? { tag: "Fork", effectRef: a as RefId }
          : { tag: "Fork", effectRef: a as RefId, scopeId: b });
        break;
      case OpcodeTagCode.HostAction:
        nodes.push(b === NONE_U32
          ? { tag: "HostAction", actionRef: a as RefId }
          : { tag: "HostAction", actionRef: a as RefId, decodeRef: b as RefId });
        break;
      default:
        throw new Error(`Unknown Brass opcode ${tag} at node ${nodeIndex}`);
    }
  }
  return nodes;
}

function validateNodeReferences(nodes: readonly OpcodeNode[], total: number): void {
  nodes.forEach((node, index) => {
    if ((node.tag === "FlatMap" || node.tag === "Fold") && node.first >= total) {
      throw new Error(`Brass opcode node ${index} references ${node.first} outside ${total} nodes`);
    }
  });
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
      return b === NONE_U32
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
  if (count > ENGINE_ABI_LIMITS.maxEventBatch) {
    throw new Error(`Brass event batch ${count} exceeds the ${ENGINE_ABI_LIMITS.maxEventBatch}-event ABI limit`);
  }
  const events: EngineEvent[] = [];
  const max = Math.min(count, Math.floor((words.length - 1) / EVENT_WORDS));
  for (let i = 0; i < max; i++) {
    events.push(decodeEvent(words, 1 + i * EVENT_WORDS));
  }
  return events;
}
