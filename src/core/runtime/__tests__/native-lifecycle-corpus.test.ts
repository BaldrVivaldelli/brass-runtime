import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeOpcodeProgram,
  decodeOpcodeNodes,
  decodeOpcodeProgram,
  NONE_U32,
} from "../engine/binaryAbi";
import { ReferenceWasmBridge } from "../engine/bridge/ReferenceWasmBridge";
import { WasmPackFiberBridge } from "../engine/bridge/WasmPackFiberBridge";
import type { EngineEvent } from "../engine/types";
import type { NodeId, OpcodeNode, OpcodeProgram } from "../engine/opcodes";
import { resolveWasmModule } from "../wasmModule";

type CorpusStep = {
  readonly op: "poll" | "provideValue" | "provideError" | "provideEffect" | "interrupt";
  readonly ref?: number;
  readonly root?: number;
  readonly nodes?: readonly (readonly [number, number, number, number])[];
  readonly eventWords: readonly [number, number, number, number, number];
};

type CorpusCase = {
  readonly name: string;
  readonly programWords: readonly number[];
  readonly steps: readonly CorpusStep[];
  readonly terminal: "done" | "failed" | "interrupted";
};

type Corpus = {
  readonly version: 1;
  readonly eventFiberId: 0;
  readonly cases: readonly CorpusCase[];
};

type Bridge = {
  createFiber(program: OpcodeProgram): number;
  poll(fiberId: number): EngineEvent;
  provideValue(fiberId: number, ref: number): EngineEvent;
  provideError(fiberId: number, ref: number): EngineEvent;
  provideEffect(fiberId: number, root: NodeId, nodes: OpcodeNode[]): EngineEvent;
  interrupt(fiberId: number, ref: number): EngineEvent;
  dropFiber(fiberId: number): void;
  stats(): unknown;
};

const corpus = JSON.parse(readFileSync(
  resolve(process.cwd(), "fixtures/native-lifecycle-v1.json"),
  "utf8",
)) as Corpus;

const bridgeFactories: readonly [string, () => Bridge][] = [
  ["typescript-reference", () => new ReferenceWasmBridge()],
  ...(resolveWasmModule({ fresh: true }) === null
    ? []
    : [["generated-wasm", () => new WasmPackFiberBridge()] as [string, () => Bridge]]),
];

describe("shared native lifecycle corpus v1", () => {
  it("round-trips every canonical program through the TypeScript ABI codec", () => {
    expect(corpus.version).toBe(1);
    expect(corpus.eventFiberId).toBe(0);
    for (const testCase of corpus.cases) {
      const program = decodeOpcodeProgram(testCase.programWords);
      expect([...encodeOpcodeProgram(program)], testCase.name).toEqual(testCase.programWords);
    }
  });

  for (const [engine, makeBridge] of bridgeFactories) {
    it(`${engine} matches all canonical transitions and terminal metrics`, () => {
      for (const testCase of corpus.cases) {
        const bridge = makeBridge();
        const fiberId = bridge.createFiber(decodeOpcodeProgram(testCase.programWords));

        for (const step of testCase.steps) {
          const event = runStep(bridge, fiberId, step);
          expect(normalizedEventWords(event), `${testCase.name}/${step.op}`)
            .toEqual(step.eventWords);
        }

        const stats = bridge.stats() as Record<string, number>;
        expect(stats.started, `${testCase.name}/started`).toBe(1);
        expect(stats.completed ?? 0, `${testCase.name}/completed`)
          .toBe(testCase.terminal === "done" ? 1 : 0);
        expect(stats.failed ?? 0, `${testCase.name}/failed`)
          .toBe(testCase.terminal === "failed" ? 1 : 0);
        expect(stats.interrupted ?? 0, `${testCase.name}/interrupted`)
          .toBe(testCase.terminal === "interrupted" ? 1 : 0);
        bridge.dropFiber(fiberId);
      }
    });
  }
});

function runStep(bridge: Bridge, fiberId: number, step: CorpusStep): EngineEvent {
  switch (step.op) {
    case "poll":
      return bridge.poll(fiberId);
    case "provideValue":
      return bridge.provideValue(fiberId, step.ref ?? 0);
    case "provideError":
      return bridge.provideError(fiberId, step.ref ?? 0);
    case "interrupt":
      return bridge.interrupt(fiberId, step.ref ?? 0);
    case "provideEffect": {
      const rawNodes = step.nodes ?? [];
      const words = new Uint32Array(1 + rawNodes.length * 4);
      words[0] = rawNodes.length;
      rawNodes.forEach((node, index) => words.set(node, 1 + index * 4));
      return bridge.provideEffect(
        fiberId,
        (step.root ?? 0) as NodeId,
        decodeOpcodeNodes(words),
      );
    }
  }
}

function normalizedEventWords(event: EngineEvent): readonly number[] {
  switch (event.kind) {
    case "Continue": return [0, 0, 0, 0, 0];
    case "Done": return [1, 0, event.valueRef, 0, 0];
    case "Failed": return [2, 0, event.errorRef, 0, 0];
    case "Interrupted": return [3, 0, event.reasonRef, 0, 0];
    case "InvokeSync": return [4, 0, event.fnRef, 0, 0];
    case "InvokeAsync": return [5, 0, event.registerRef, 0, 0];
    case "InvokeFlatMap": return [6, 0, event.fnRef, event.valueRef, 0];
    case "InvokeFoldFailure": return [7, 0, event.fnRef, event.errorRef, 0];
    case "InvokeFoldSuccess": return [8, 0, event.fnRef, event.valueRef, 0];
    case "InvokeFork": return [9, 0, event.effectRef, event.scopeId ?? NONE_U32, 0];
    case "InvokeHostAction": return [10, 0, event.actionRef, event.decodeRef ?? NONE_U32, 0];
  }
}
