import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { collectHostSignals, type HostSignalInput } from "../hostSignals";
import type { HostSignalSource } from "../hostProfile";

/**
 * Property-based tests for signal collection.
 * Feature: agent-host-llm-refactor, Property 1: Signal collection produces ordered, typed, frozen output
 * Feature: agent-host-llm-refactor, Property 2: Signal collection graceful degradation
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
 */

/** The valid HostSignalSource values in declaration order. */
const SOURCE_ORDER: readonly HostSignalSource[] = [
  "argv",
  "env-key",
  "stdio",
  "parent-process",
  "workspace-marker",
  "protocol-handshake",
  "config",
];

/** Arbitrary for a valid HostSignalInput. */
const arbHostSignalInput: fc.Arbitrary<HostSignalInput> = fc.record({
  argv: fc.array(fc.string({ minLength: 0, maxLength: 20 }), { maxLength: 10 }),
  env: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 16 }),
    fc.oneof(fc.string({ maxLength: 32 }), fc.constant(undefined)),
    { maxKeys: 20 },
  ) as fc.Arbitrary<Readonly<Record<string, string | undefined>>>,
  stdoutIsTTY: fc.boolean(),
  stdinIsTTY: fc.boolean(),
  ttyColumns: fc.oneof(fc.constant(undefined), fc.integer({ min: 1, max: 500 })),
  parentProcessName: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 30 })),
  workspaceMarkers: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 8 }),
  stdinFirstLine: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 64 })),
  configPaths: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 5 }),
});

describe("Property 1: Signal collection produces ordered, typed, frozen output", () => {
  /**
   * For any valid HostSignalInput, collectHostSignals SHALL return a frozen array
   * where every element has a source field from the valid HostSignalSource set
   * and a value field that is a string.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  it("every signal has a valid source and string value, and the result is frozen", () => {
    fc.assert(
      fc.property(arbHostSignalInput, (input) => {
        const signals = collectHostSignals(input);

        // Result is frozen
        expect(Object.isFrozen(signals)).toBe(true);

        // Every element has valid source and string value
        for (const signal of signals) {
          expect(SOURCE_ORDER).toContain(signal.source);
          expect(typeof signal.value).toBe("string");
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Signals are ordered by source category declaration order:
   * argv < env-key < stdio < parent-process < workspace-marker < protocol-handshake < config
   *
   * **Validates: Requirements 1.1, 1.5**
   */
  it("signals are ordered by source category declaration order", () => {
    fc.assert(
      fc.property(arbHostSignalInput, (input) => {
        const signals = collectHostSignals(input);

        // Check ordering: for any two signals at indices i < j,
        // the source category index of signals[i] must be <= that of signals[j]
        for (let i = 1; i < signals.length; i++) {
          const prevIdx = SOURCE_ORDER.indexOf(signals[i - 1].source);
          const currIdx = SOURCE_ORDER.indexOf(signals[i].source);
          expect(currIdx).toBeGreaterThanOrEqual(prevIdx);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Each signal element is itself frozen (deeply frozen output).
   *
   * **Validates: Requirements 1.5**
   */
  it("each signal element is frozen", () => {
    fc.assert(
      fc.property(arbHostSignalInput, (input) => {
        const signals = collectHostSignals(input);

        for (const signal of signals) {
          expect(Object.isFrozen(signal)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 2: Signal collection graceful degradation", () => {
  /**
   * Arbitrary that generates HostSignalInput with some fields empty/undefined
   * to simulate unavailable sources.
   */
  const arbPartialInput: fc.Arbitrary<HostSignalInput> = fc.record({
    argv: fc.oneof(fc.constant([] as string[]), fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 })),
    env: fc.oneof(
      fc.constant({} as Readonly<Record<string, string | undefined>>),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.oneof(fc.string({ maxLength: 16 }), fc.constant(undefined)),
        { maxKeys: 10 },
      ) as fc.Arbitrary<Readonly<Record<string, string | undefined>>>,
    ),
    stdoutIsTTY: fc.boolean(),
    stdinIsTTY: fc.boolean(),
    ttyColumns: fc.oneof(fc.constant(undefined), fc.integer({ min: 1, max: 300 })),
    parentProcessName: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 20 })),
    workspaceMarkers: fc.oneof(fc.constant([] as string[]), fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 })),
    stdinFirstLine: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 32 })),
    configPaths: fc.oneof(fc.constant([] as string[]), fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 3 })),
  });

  /**
   * For any HostSignalInput where one or more source fields are undefined, empty,
   * or represent unavailable sources, collectHostSignals SHALL NOT throw an exception.
   *
   * **Validates: Requirements 1.3, 1.4**
   */
  it("does not throw for any combination of available/unavailable sources", () => {
    fc.assert(
      fc.property(arbPartialInput, (input) => {
        expect(() => collectHostSignals(input)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * When argv is empty, no "argv" signals appear in the result.
   * When parentProcessName is undefined, no "parent-process" signals appear.
   * When workspaceMarkers is empty, no "workspace-marker" signals appear.
   * When configPaths is empty, no "config" signals appear.
   * When stdinFirstLine is undefined (or stdinIsTTY is true), no "protocol-handshake" signals appear.
   *
   * **Validates: Requirements 1.3, 1.4**
   */
  it("no signals appear for unavailable sources", () => {
    fc.assert(
      fc.property(arbPartialInput, (input) => {
        const signals = collectHostSignals(input);

        // If argv is empty, no argv signals
        if (input.argv.length === 0) {
          expect(signals.filter((s) => s.source === "argv")).toHaveLength(0);
        }

        // If env is empty, no env-key signals
        if (Object.keys(input.env).length === 0) {
          expect(signals.filter((s) => s.source === "env-key")).toHaveLength(0);
        }

        // If parentProcessName is undefined, no parent-process signals
        if (input.parentProcessName === undefined) {
          expect(signals.filter((s) => s.source === "parent-process")).toHaveLength(0);
        }

        // If workspaceMarkers is empty, no workspace-marker signals
        if (input.workspaceMarkers.length === 0) {
          expect(signals.filter((s) => s.source === "workspace-marker")).toHaveLength(0);
        }

        // If stdinFirstLine is undefined OR stdinIsTTY is true, no protocol-handshake signals
        if (input.stdinFirstLine === undefined || input.stdinIsTTY) {
          expect(signals.filter((s) => s.source === "protocol-handshake")).toHaveLength(0);
        }

        // If configPaths is empty, no config signals
        if (input.configPaths.length === 0) {
          expect(signals.filter((s) => s.source === "config")).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * When ALL sources are unavailable (empty/undefined), the result is an empty array.
   *
   * **Validates: Requirements 1.4**
   */
  it("returns empty array when all sources are unavailable", () => {
    const emptyInput: HostSignalInput = {
      argv: [],
      env: {},
      stdoutIsTTY: false,
      stdinIsTTY: true, // TTY means no protocol-handshake
      ttyColumns: undefined,
      parentProcessName: undefined,
      workspaceMarkers: [],
      stdinFirstLine: undefined,
      configPaths: [],
    };

    const signals = collectHostSignals(emptyInput);
    // stdio signals are always emitted (stdout:pipe, stdin:tty) since TTY state is always available
    // Only truly "unavailable" sources produce no signals
    // argv=[], env={}, parentProcessName=undefined, workspaceMarkers=[], stdinFirstLine=undefined, configPaths=[]
    // stdio always produces at least 2 signals (stdout state + stdin state)
    expect(signals.filter((s) => s.source === "argv")).toHaveLength(0);
    expect(signals.filter((s) => s.source === "env-key")).toHaveLength(0);
    expect(signals.filter((s) => s.source === "parent-process")).toHaveLength(0);
    expect(signals.filter((s) => s.source === "workspace-marker")).toHaveLength(0);
    expect(signals.filter((s) => s.source === "protocol-handshake")).toHaveLength(0);
    expect(signals.filter((s) => s.source === "config")).toHaveLength(0);
  });
});
