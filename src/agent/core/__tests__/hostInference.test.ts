import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
    inferTransport,
    inferCapabilities,
    inferConstraints,
    inferOptionalIdentity,
    buildHostProfile,
    CI_INDICATORS,
} from "../hostInference";
import type { HostCapabilities, HostSignal, HostSignalSource, HostTransport } from "../hostProfile";
import { collectHostSignals, type HostSignalInput } from "../hostSignals";

/**
 * Property-based tests for host inference pipeline.
 * Feature: agent-host-llm-refactor
 *
 * Property 3: Transport inference validity and priority resolution
 * Property 4: MCP transport dominance
 * Property 5: Capability inference completeness and defaults
 * Property 6: Constraint inference derivation rules
 *
 * **Validates: Requirements 2.1, 2.2, 2.8, 3.1, 3.10, 4.1, 4.2, 4.3**
 */

// --- Shared Arbitraries ---

const VALID_SOURCES: readonly HostSignalSource[] = [
  "argv",
  "env-key",
  "stdio",
  "parent-process",
  "workspace-marker",
  "protocol-handshake",
  "config",
];

const VALID_TRANSPORTS: readonly HostTransport[] = [
  "stdio",
  "terminal",
  "mcp",
  "extension",
  "ci",
  "unknown",
];

/** Arbitrary for a valid HostSignal. */
const arbHostSignal: fc.Arbitrary<HostSignal> = fc.record({
  source: fc.constantFrom(...VALID_SOURCES),
  value: fc.string({ minLength: 0, maxLength: 40 }),
});

/** Arbitrary for an array of HostSignals. */
const arbHostSignalArray: fc.Arbitrary<readonly HostSignal[]> = fc.array(arbHostSignal, {
  maxLength: 20,
});

// --- Transport-specific arbitraries (Properties 3, 4) ---

/** Extension markers that trigger extension transport. */
const EXTENSION_MARKERS = [".vscode", ".cursor", ".kiro"];

/** Arbitrary for a signal that triggers MCP transport. */
const arbMcpSignal: fc.Arbitrary<HostSignal> = fc.record({
  source: fc.constant("protocol-handshake" as HostSignalSource),
  value: fc
    .tuple(
      fc.string({ maxLength: 10 }),
      fc.constantFrom("mcp", "MCP", "Mcp"),
      fc.string({ maxLength: 10 }),
    )
    .map(([prefix, mcp, suffix]) => `${prefix}${mcp}${suffix}`),
});

/** Arbitrary for a signal that triggers extension transport. */
const arbExtensionSignal: fc.Arbitrary<HostSignal> = fc.oneof(
  fc.record({
    source: fc.constant("workspace-marker" as HostSignalSource),
    value: fc.constantFrom(...EXTENSION_MARKERS).map((m) => `path/to/${m}/settings`),
  }),
  fc.record({
    source: fc.constant("config" as HostSignalSource),
    value: fc.constantFrom(...EXTENSION_MARKERS).map((m) => `/home/user/${m}/config.json`),
  }),
);

/** Arbitrary for a signal that triggers CI transport. */
const arbCiSignal: fc.Arbitrary<HostSignal> = fc.record({
  source: fc.constant("env-key" as HostSignalSource),
  value: fc.constantFrom(...CI_INDICATORS),
});

/**
 * Arbitrary for signals that do NOT trigger any transport on their own.
 * These are "neutral" signals that won't match any transport pattern.
 */
const arbNeutralSignal: fc.Arbitrary<HostSignal> = fc.oneof(
  fc.record({
    source: fc.constant("argv" as HostSignalSource),
    value: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({
    source: fc.constant("parent-process" as HostSignalSource),
    value: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.record({
    source: fc.constant("stdio" as HostSignalSource),
    value: fc.constantFrom("stdin:tty", "stdin:pipe", "columns:120"),
  }),
);

/** Arbitrary for a valid HostTransport value. */
const arbHostTransport: fc.Arbitrary<HostTransport> = fc.constantFrom(...VALID_TRANSPORTS);

/** Arbitrary for a valid HostCapabilities record. */
const arbHostCapabilities: fc.Arbitrary<HostCapabilities> = fc.record({
  hasOwnLLM: fc.boolean(),
  wantsJson: fc.boolean(),
  supportsStreamingEvents: fc.boolean(),
  supportsMcp: fc.boolean(),
  canAskApproval: fc.boolean(),
  canRenderDiff: fc.boolean(),
  canApplyPatch: fc.boolean(),
  interactiveTty: fc.boolean(),
});

/** The 8 expected capability fields. */
const CAPABILITY_FIELDS = [
  "hasOwnLLM",
  "wantsJson",
  "supportsStreamingEvents",
  "supportsMcp",
  "canAskApproval",
  "canRenderDiff",
  "canApplyPatch",
  "interactiveTty",
] as const;

/** The 3 expected constraint fields. */
const CONSTRAINT_FIELDS = [
  "readOnlyByDefault",
  "patchPreviewRequired",
  "requireNoNetwork",
] as const;

// --- Property 3: Transport inference validity and priority resolution ---

describe("Property 3: Transport inference validity and priority resolution", () => {
  /**
   * Feature: agent-host-llm-refactor, Property 3: Transport inference validity and priority resolution
   *
   * For any array of HostSignal values, inferTransport SHALL return exactly one value
   * from the set {"stdio", "terminal", "mcp", "extension", "ci", "unknown"}.
   *
   * **Validates: Requirements 2.1, 2.2, 2.8**
   */
  it("always returns a valid transport value for any signal array", () => {
    fc.assert(
      fc.property(arbHostSignalArray, (signals) => {
        const transport = inferTransport(signals);
        expect(VALID_TRANSPORTS).toContain(transport);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * When the signal array contains indicators for multiple transport patterns
   * simultaneously, the returned transport SHALL be the highest-priority match
   * according to the fixed order: mcp > extension > ci > terminal > stdio > unknown.
   *
   * **Validates: Requirements 2.1, 2.8**
   */
  it("mcp takes priority over extension", () => {
    fc.assert(
      fc.property(
        arbMcpSignal,
        arbExtensionSignal,
        fc.array(arbNeutralSignal, { maxLength: 5 }),
        (mcpSig, extSig, neutralSigs) => {
          const signals = [...neutralSigs, mcpSig, extSig];
          expect(inferTransport(signals)).toBe("mcp");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("extension takes priority over ci", () => {
    fc.assert(
      fc.property(
        arbExtensionSignal,
        arbCiSignal,
        fc.array(arbNeutralSignal, { maxLength: 5 }),
        (extSig, ciSig, neutralSigs) => {
          const signals = [...neutralSigs, extSig, ciSig];
          expect(inferTransport(signals)).toBe("extension");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("ci takes priority over terminal", () => {
    fc.assert(
      fc.property(
        arbCiSignal,
        fc.array(arbNeutralSignal, { maxLength: 5 }),
        (ciSig, neutralSigs) => {
          const terminalSig: HostSignal = { source: "stdio", value: "stdout:tty" };
          const signals = [...neutralSigs, ciSig, terminalSig];
          expect(inferTransport(signals)).toBe("ci");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("terminal takes priority over stdio", () => {
    fc.assert(
      fc.property(fc.array(arbNeutralSignal, { maxLength: 5 }), (neutralSigs) => {
        const ttySig: HostSignal = { source: "stdio", value: "stdout:tty" };
        const pipeSig: HostSignal = { source: "stdio", value: "stdout:pipe" };
        const signals = [...neutralSigs, ttySig, pipeSig];
        expect(inferTransport(signals)).toBe("terminal");
      }),
      { numRuns: 100 },
    );
  });

  it("stdio takes priority over unknown (pipe present, no higher match)", () => {
    fc.assert(
      fc.property(fc.array(arbNeutralSignal, { maxLength: 5 }), (neutralSigs) => {
        const pipeSig: HostSignal = { source: "stdio", value: "stdout:pipe" };
        const signals = [...neutralSigs, pipeSig];
        expect(inferTransport(signals)).toBe("stdio");
      }),
      { numRuns: 100 },
    );
  });

  it("returns unknown when no signals match any transport pattern", () => {
    fc.assert(
      fc.property(fc.array(arbNeutralSignal, { maxLength: 10 }), (neutralSigs) => {
        // Filter out any accidental stdout:tty or stdout:pipe from neutral signals
        const filtered = neutralSigs.filter(
          (s) => !(s.source === "stdio" && (s.value === "stdout:tty" || s.value === "stdout:pipe")),
        );
        expect(inferTransport(filtered)).toBe("unknown");
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Full priority chain: when all transport triggers are present simultaneously,
   * mcp (highest priority) wins.
   *
   * **Validates: Requirements 2.1, 2.8**
   */
  it("mcp wins when all transport triggers are present simultaneously", () => {
    fc.assert(
      fc.property(
        arbMcpSignal,
        arbExtensionSignal,
        arbCiSignal,
        (mcpSig, extSig, ciSig) => {
          const terminalSig: HostSignal = { source: "stdio", value: "stdout:tty" };
          const pipeSig: HostSignal = { source: "stdio", value: "stdout:pipe" };
          const signals = [mcpSig, extSig, ciSig, terminalSig, pipeSig];
          expect(inferTransport(signals)).toBe("mcp");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Property 4: MCP transport dominance ---

describe("Property 4: MCP transport dominance", () => {
  /**
   * Feature: agent-host-llm-refactor, Property 4: MCP transport dominance
   *
   * For any array of HostSignal values that includes a protocol-handshake signal
   * with value indicating MCP, inferTransport SHALL return "mcp" regardless of
   * what other signals are present in the array.
   *
   * **Validates: Requirements 2.2**
   */
  it("returns mcp when protocol-handshake signal contains mcp, regardless of other signals", () => {
    fc.assert(
      fc.property(
        arbMcpSignal,
        arbHostSignalArray,
        (mcpSig, otherSignals) => {
          const signals = [...otherSignals, mcpSig];
          expect(inferTransport(signals)).toBe("mcp");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns mcp for various mcp value formats in protocol-handshake", () => {
    const mcpValues = [
      "mcp",
      "MCP",
      "mcp-protocol",
      "protocol:mcp",
      "initialize-mcp-session",
      "MCP_HANDSHAKE",
      "some-prefix-mcp-suffix",
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...mcpValues),
        arbHostSignalArray,
        (mcpValue, otherSignals) => {
          const mcpSig: HostSignal = { source: "protocol-handshake", value: mcpValue };
          const signals = [...otherSignals, mcpSig];
          expect(inferTransport(signals)).toBe("mcp");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("mcp dominates even when extension, ci, terminal, and stdio signals are all present", () => {
    fc.assert(
      fc.property(arbMcpSignal, (mcpSig) => {
        const signals: HostSignal[] = [
          // Extension trigger
          { source: "workspace-marker", value: ".vscode/settings.json" },
          // CI trigger
          { source: "env-key", value: "GITHUB_ACTIONS" },
          // Terminal trigger
          { source: "stdio", value: "stdout:tty" },
          // Stdio trigger
          { source: "stdio", value: "stdout:pipe" },
          // MCP trigger (should dominate)
          mcpSig,
        ];
        expect(inferTransport(signals)).toBe("mcp");
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 5: Capability inference completeness and defaults ---

describe("Property 5: Capability inference completeness and defaults", () => {
  /**
   * For any valid HostSignal array and any valid HostTransport value,
   * inferCapabilities SHALL return a HostCapabilities record containing
   * exactly the 8 expected boolean fields.
   *
   * **Validates: Requirements 3.1**
   */
  it("returns an object with exactly the 8 expected boolean fields", () => {
    fc.assert(
      fc.property(arbHostSignalArray, arbHostTransport, (signals, transport) => {
        const capabilities = inferCapabilities(signals, transport);

        // Exactly 8 fields
        const keys = Object.keys(capabilities);
        expect(keys).toHaveLength(8);

        // Each expected field is present and is a boolean
        for (const field of CAPABILITY_FIELDS) {
          expect(field in capabilities).toBe(true);
          expect(typeof capabilities[field]).toBe("boolean");
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * With an empty signal array, all capabilities are false except those
   * derived from transport alone:
   * - wantsJson is true for "stdio" and "mcp"
   * - supportsStreamingEvents is true for "terminal", "mcp", "extension"
   * - supportsMcp is true for "mcp"
   * - canAskApproval is true for "extension" and "mcp"
   * - canRenderDiff is true for "extension"
   * - canApplyPatch is true for "extension" and "mcp"
   *
   * **Validates: Requirements 3.10**
   */
  it("with empty signals, capabilities default to false except transport-derived ones", () => {
    fc.assert(
      fc.property(arbHostTransport, (transport) => {
        const capabilities = inferCapabilities([], transport);

        // hasOwnLLM: always false with no signals (no env-key or protocol-handshake)
        expect(capabilities.hasOwnLLM).toBe(false);

        // wantsJson: true for stdio and mcp transports
        const expectedWantsJson = transport === "stdio" || transport === "mcp";
        expect(capabilities.wantsJson).toBe(expectedWantsJson);

        // supportsStreamingEvents: true for terminal, mcp, extension
        const expectedStreaming =
          transport === "terminal" || transport === "mcp" || transport === "extension";
        expect(capabilities.supportsStreamingEvents).toBe(expectedStreaming);

        // supportsMcp: true only for mcp
        expect(capabilities.supportsMcp).toBe(transport === "mcp");

        // canAskApproval: true for extension and mcp (no stdin:tty signal with empty array)
        const expectedApproval = transport === "extension" || transport === "mcp";
        expect(capabilities.canAskApproval).toBe(expectedApproval);

        // canRenderDiff: true for extension (no TTY columns signal with empty array)
        expect(capabilities.canRenderDiff).toBe(transport === "extension");

        // canApplyPatch: true for extension and mcp
        const expectedPatch = transport === "extension" || transport === "mcp";
        expect(capabilities.canApplyPatch).toBe(expectedPatch);

        // interactiveTty: always false with no signals (no stdout:tty signal)
        expect(capabilities.interactiveTty).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Each field is always a boolean (never undefined, null, or other type).
   *
   * **Validates: Requirements 3.1, 3.10**
   */
  it("all capability fields are strictly boolean (not undefined or null)", () => {
    fc.assert(
      fc.property(arbHostSignalArray, arbHostTransport, (signals, transport) => {
        const capabilities = inferCapabilities(signals, transport);

        for (const field of CAPABILITY_FIELDS) {
          const value = capabilities[field];
          expect(value === true || value === false).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 6: Constraint inference derivation rules ---

describe("Property 6: Constraint inference derivation rules", () => {
  /**
   * For any valid HostCapabilities record and HostTransport value,
   * inferConstraints SHALL return a HostConstraints record with exactly
   * the 3 expected boolean fields.
   *
   * **Validates: Requirements 4.1**
   */
  it("returns an object with exactly the 3 expected boolean fields", () => {
    fc.assert(
      fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
        const constraints = inferConstraints(capabilities, transport);

        const keys = Object.keys(constraints);
        expect(keys).toHaveLength(3);

        for (const field of CONSTRAINT_FIELDS) {
          expect(field in constraints).toBe(true);
          expect(typeof constraints[field]).toBe("boolean");
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * readOnlyByDefault is true if and only if transport is "ci".
   *
   * **Validates: Requirements 4.2**
   */
  it("readOnlyByDefault is true iff transport is 'ci'", () => {
    fc.assert(
      fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
        const constraints = inferConstraints(capabilities, transport);

        if (transport === "ci") {
          expect(constraints.readOnlyByDefault).toBe(true);
        } else {
          expect(constraints.readOnlyByDefault).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * patchPreviewRequired is true if and only if canRenderDiff is true
   * AND canApplyPatch is false.
   *
   * **Validates: Requirements 4.3**
   */
  it("patchPreviewRequired is true iff canRenderDiff=true AND canApplyPatch=false", () => {
    fc.assert(
      fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
        const constraints = inferConstraints(capabilities, transport);

        const expected =
          capabilities.canRenderDiff === true && capabilities.canApplyPatch === false;
        expect(constraints.patchPreviewRequired).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * requireNoNetwork is always false (no signal currently triggers it).
   *
   * **Validates: Requirements 4.1**
   */
  it("requireNoNetwork is always false", () => {
    fc.assert(
      fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
        const constraints = inferConstraints(capabilities, transport);

        expect(constraints.requireNoNetwork).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * All fields default to false when their inference rules do not match.
   *
   * **Validates: Requirements 4.1**
   */
  it("all fields are false when no inference rules match", () => {
    // Non-ci transport + canRenderDiff=false → all constraints false
    const nonCiTransports: HostTransport[] = ["stdio", "terminal", "mcp", "extension", "unknown"];

    fc.assert(
      fc.property(
        fc.constantFrom(...nonCiTransports),
        fc.boolean(),
        (transport, canApplyPatch) => {
          const capabilities: HostCapabilities = {
            hasOwnLLM: false,
            wantsJson: false,
            supportsStreamingEvents: false,
            supportsMcp: false,
            canAskApproval: false,
            canRenderDiff: false, // false means patchPreviewRequired won't trigger
            canApplyPatch,
            interactiveTty: false,
          };

          const constraints = inferConstraints(capabilities, transport);

          expect(constraints.readOnlyByDefault).toBe(false);
          expect(constraints.patchPreviewRequired).toBe(false);
          expect(constraints.requireNoNetwork).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property-based tests for pipeline determinism and error-free defaults.
 * Feature: agent-host-llm-refactor, Property 12: Pipeline determinism
 * Feature: agent-host-llm-refactor, Property 13: Pipeline error-free defaults
 *
 * **Validates: Requirements 12.2, 12.3, 12.4, 12.5**
 */

// --- Arbitraries for Properties 12 and 13 ---

const arbHostSignalInput: fc.Arbitrary<HostSignalInput> = fc.record({
    argv: fc.array(fc.string({ maxLength: 20 }), { maxLength: 10 }),
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

// --- Property 12: Pipeline determinism ---

describe("Property 12: Pipeline determinism", () => {
    /**
     * For any HostSignalInput, invoking buildHostProfile twice with the same input
     * SHALL produce structurally equal HostProfile results (deep equality on all fields).
     *
     * **Validates: Requirements 12.2, 12.3**
     */
    it("buildHostProfile produces identical results for the same input", () => {
        fc.assert(
            fc.property(arbHostSignalInput, (input) => {
                const profile1 = buildHostProfile(input);
                const profile2 = buildHostProfile(input);
                expect(profile1).toEqual(profile2);
            }),
            { numRuns: 100 },
        );
    });

    /**
     * inferTransport is deterministic when given the same signals.
     *
     * **Validates: Requirements 12.5**
     */
    it("inferTransport is deterministic for the same input", () => {
        fc.assert(
            fc.property(arbHostSignalInput, (input) => {
                const signals = collectHostSignals(input);
                const result1 = inferTransport(signals);
                const result2 = inferTransport(signals);
                expect(result1).toBe(result2);
            }),
            { numRuns: 100 },
        );
    });

    /**
     * inferCapabilities is deterministic when given the same inputs.
     *
     * **Validates: Requirements 12.5**
     */
    it("inferCapabilities is deterministic for the same inputs", () => {
        fc.assert(
            fc.property(arbHostSignalInput, (input) => {
                const signals = collectHostSignals(input);
                const transport = inferTransport(signals);
                const result1 = inferCapabilities(signals, transport);
                const result2 = inferCapabilities(signals, transport);
                expect(result1).toEqual(result2);
            }),
            { numRuns: 100 },
        );
    });

    /**
     * inferConstraints is deterministic when given the same inputs.
     *
     * **Validates: Requirements 12.5**
     */
    it("inferConstraints is deterministic for the same inputs", () => {
        fc.assert(
            fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
                const result1 = inferConstraints(capabilities, transport);
                const result2 = inferConstraints(capabilities, transport);
                expect(result1).toEqual(result2);
            }),
            { numRuns: 100 },
        );
    });

    /**
     * inferOptionalIdentity is deterministic when given the same signals.
     *
     * **Validates: Requirements 12.5**
     */
    it("inferOptionalIdentity is deterministic for the same input", () => {
        fc.assert(
            fc.property(arbHostSignalInput, (input) => {
                const signals = collectHostSignals(input);
                const result1 = inferOptionalIdentity(signals);
                const result2 = inferOptionalIdentity(signals);
                expect(result1).toEqual(result2);
            }),
            { numRuns: 100 },
        );
    });
});

// --- Property 13: Pipeline error-free defaults ---

describe("Property 13: Pipeline error-free defaults", () => {
    /**
     * inferTransport with an empty signal array returns "unknown".
     *
     * **Validates: Requirements 12.4**
     */
    it("inferTransport returns 'unknown' for empty signals", () => {
        const result = inferTransport([]);
        expect(result).toBe("unknown");
    });

    /**
     * inferCapabilities with empty signals and each transport returns an object
     * where all fields are boolean.
     *
     * **Validates: Requirements 12.4**
     */
    it("inferCapabilities returns all-boolean fields for empty signals with each transport", () => {
        for (const transport of VALID_TRANSPORTS) {
            const result = inferCapabilities([], transport);
            expect(typeof result.hasOwnLLM).toBe("boolean");
            expect(typeof result.wantsJson).toBe("boolean");
            expect(typeof result.supportsStreamingEvents).toBe("boolean");
            expect(typeof result.supportsMcp).toBe("boolean");
            expect(typeof result.canAskApproval).toBe("boolean");
            expect(typeof result.canRenderDiff).toBe("boolean");
            expect(typeof result.canApplyPatch).toBe("boolean");
            expect(typeof result.interactiveTty).toBe("boolean");
        }
    });

    /**
     * inferConstraints with all-false capabilities and each transport returns
     * a valid constraints object with all boolean fields.
     *
     * **Validates: Requirements 12.4**
     */
    it("inferConstraints returns valid constraints for all-false capabilities with each transport", () => {
        const allFalseCapabilities: HostCapabilities = {
            hasOwnLLM: false,
            wantsJson: false,
            supportsStreamingEvents: false,
            supportsMcp: false,
            canAskApproval: false,
            canRenderDiff: false,
            canApplyPatch: false,
            interactiveTty: false,
        };

        for (const transport of VALID_TRANSPORTS) {
            const result = inferConstraints(allFalseCapabilities, transport);
            expect(typeof result.readOnlyByDefault).toBe("boolean");
            expect(typeof result.patchPreviewRequired).toBe("boolean");
            expect(typeof result.requireNoNetwork).toBe("boolean");
        }
    });

    /**
     * inferOptionalIdentity with empty signals returns undefined.
     *
     * **Validates: Requirements 12.4**
     */
    it("inferOptionalIdentity returns undefined for empty signals", () => {
        const result = inferOptionalIdentity([]);
        expect(result).toBeUndefined();
    });

    /**
     * For any arbitrary input, no inference stage throws an exception.
     *
     * **Validates: Requirements 12.4**
     */
    it("no inference stage throws for arbitrary inputs", () => {
        fc.assert(
            fc.property(arbHostSignalInput, (input) => {
                const signals = collectHostSignals(input);

                expect(() => inferTransport(signals)).not.toThrow();

                for (const transport of VALID_TRANSPORTS) {
                    expect(() => inferCapabilities(signals, transport)).not.toThrow();
                }

                const transport = inferTransport(signals);
                const capabilities = inferCapabilities(signals, transport);
                expect(() => inferConstraints(capabilities, transport)).not.toThrow();

                expect(() => inferOptionalIdentity(signals)).not.toThrow();
            }),
            { numRuns: 100 },
        );
    });

    /**
     * For any arbitrary capabilities and transport, inferConstraints does not throw.
     *
     * **Validates: Requirements 12.4**
     */
    it("inferConstraints does not throw for arbitrary capabilities and transport", () => {
        fc.assert(
            fc.property(arbHostCapabilities, arbHostTransport, (capabilities, transport) => {
                expect(() => inferConstraints(capabilities, transport)).not.toThrow();
            }),
            { numRuns: 100 },
        );
    });
});
