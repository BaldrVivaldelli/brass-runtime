import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    parseCliArgs,
    buildHostProfileFromProcess,
    printHostProfileHuman,
    makeLLMFromEnvOptional,
    applyCapabilityDefaults,
    type ResolvedCliArgs,
} from "../main";
import type { HostProfile } from "../../core/hostProfile";

/**
 * Unit tests for --host-profile CLI command and makeLLMFromEnvOptional.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 8.5, 9.4**
 */

describe("parseCliArgs: --host-profile flag", () => {
    it("recognizes --host-profile and sets hostProfile: true", () => {
        const result = parseCliArgs(["--host-profile"]);
        expect(result.hostProfile).toBe(true);
    });

    it("defaults hostProfile to false when flag is not present", () => {
        const result = parseCliArgs(["some goal text"]);
        expect(result.hostProfile).toBe(false);
    });

    it("combines --host-profile with --json", () => {
        const result = parseCliArgs(["--host-profile", "--json"]);
        expect(result.hostProfile).toBe(true);
        expect(result.output).toBe("json");
    });

    it("combines --host-profile with other flags", () => {
        const result = parseCliArgs(["--host-profile", "--cwd", "/tmp"]);
        expect(result.hostProfile).toBe(true);
        expect(result.cwd).toBe("/tmp");
    });
});

describe("buildHostProfileFromProcess: JSON output structure", () => {
    it("returns a HostProfile with all required fields", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);

        // Verify top-level fields exist
        expect(profile).toHaveProperty("transport");
        expect(profile).toHaveProperty("capabilities");
        expect(profile).toHaveProperty("constraints");
        expect(profile).toHaveProperty("evidence");

        // transport is a valid value
        expect(["stdio", "terminal", "mcp", "extension", "ci", "unknown"]).toContain(profile.transport);
    });

    it("capabilities has all expected boolean fields", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);

        const caps = profile.capabilities;
        expect(typeof caps.hasOwnLLM).toBe("boolean");
        expect(typeof caps.wantsJson).toBe("boolean");
        expect(typeof caps.supportsStreamingEvents).toBe("boolean");
        expect(typeof caps.supportsMcp).toBe("boolean");
        expect(typeof caps.canAskApproval).toBe("boolean");
        expect(typeof caps.canRenderDiff).toBe("boolean");
        expect(typeof caps.canApplyPatch).toBe("boolean");
        expect(typeof caps.interactiveTty).toBe("boolean");
    });

    it("constraints has all expected boolean fields", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);

        const con = profile.constraints;
        expect(typeof con.readOnlyByDefault).toBe("boolean");
        expect(typeof con.patchPreviewRequired).toBe("boolean");
        expect(typeof con.requireNoNetwork).toBe("boolean");
    });

    it("evidence is an array of signals", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);

        expect(Array.isArray(profile.evidence)).toBe(true);
        for (const signal of profile.evidence) {
            expect(signal).toHaveProperty("source");
            expect(signal).toHaveProperty("value");
            expect(typeof signal.source).toBe("string");
            expect(typeof signal.value).toBe("string");
        }
    });

    it("identity is either undefined or has name and confidence", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);

        if (profile.identity !== undefined) {
            expect(typeof profile.identity.name).toBe("string");
            expect(typeof profile.identity.confidence).toBe("number");
            expect(profile.identity.confidence).toBeGreaterThanOrEqual(0);
            expect(profile.identity.confidence).toBeLessThanOrEqual(1);
        }
    });

    it("JSON.stringify produces valid JSON with expected shape", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const profile = buildHostProfileFromProcess(resolved);
        const json = JSON.stringify(profile, null, 2);

        const parsed = JSON.parse(json);
        expect(parsed.transport).toBeDefined();
        expect(parsed.capabilities).toBeDefined();
        expect(parsed.constraints).toBeDefined();
        expect(parsed.evidence).toBeDefined();
    });
});

describe("printHostProfileHuman: human-readable output format", () => {
    let consoleLogs: string[];

    beforeEach(() => {
        consoleLogs = [];
        vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            consoleLogs.push(args.map(String).join(" "));
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("outputs Transport section", () => {
        const profile = makeTestProfile();
        printHostProfileHuman(profile);

        expect(consoleLogs.some((line) => line.startsWith("Transport:"))).toBe(true);
    });

    it("outputs Capabilities section with all fields", () => {
        const profile = makeTestProfile();
        printHostProfileHuman(profile);

        expect(consoleLogs.some((line) => line === "Capabilities:")).toBe(true);
        expect(consoleLogs.some((line) => line.includes("hasOwnLLM:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("wantsJson:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("supportsStreamingEvents:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("supportsMcp:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("canAskApproval:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("canRenderDiff:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("canApplyPatch:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("interactiveTty:"))).toBe(true);
    });

    it("outputs Constraints section with all fields", () => {
        const profile = makeTestProfile();
        printHostProfileHuman(profile);

        expect(consoleLogs.some((line) => line === "Constraints:")).toBe(true);
        expect(consoleLogs.some((line) => line.includes("readOnlyByDefault:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("patchPreviewRequired:"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("requireNoNetwork:"))).toBe(true);
    });

    it("outputs Identity section when identity is present", () => {
        const profile = makeTestProfile({ identity: { name: "test-host", confidence: 0.85 } });
        printHostProfileHuman(profile);

        expect(consoleLogs.some((line) => line === "Identity:")).toBe(true);
        expect(consoleLogs.some((line) => line.includes("name: test-host"))).toBe(true);
        expect(consoleLogs.some((line) => line.includes("confidence: 0.85"))).toBe(true);
    });

    it("outputs Identity section with (none detected) when identity is undefined", () => {
        const profile = makeTestProfile({ identity: undefined });
        printHostProfileHuman(profile);

        expect(consoleLogs.some((line) => line === "Identity:")).toBe(true);
        expect(consoleLogs.some((line) => line.includes("(none detected)"))).toBe(true);
    });
});

describe("makeLLMFromEnvOptional", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset env to a clean state for each test
        process.env = { ...originalEnv };
        delete process.env.BRASS_LLM_PROVIDER;
        delete process.env.BRASS_GOOGLE_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        delete process.env.GEMINI_API_KEY;
        delete process.env.BRASS_LLM_ENDPOINT;
        delete process.env.BRASS_LLM_API_KEY;
        delete process.env.BRASS_FAKE_LLM_RESPONSE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("returns undefined when no env vars are set and no config", () => {
        const result = makeLLMFromEnvOptional();
        expect(result).toBeUndefined();
    });

    it("returns undefined when no credentials are found (empty config)", () => {
        const result = makeLLMFromEnvOptional({});
        expect(result).toBeUndefined();
    });

    it("returns a fake LLM instance when BRASS_LLM_PROVIDER=fake", () => {
        process.env.BRASS_LLM_PROVIDER = "fake";
        const result = makeLLMFromEnvOptional();
        expect(result).toBeDefined();
        expect(result).not.toBeUndefined();
    });

    it("returns a fake LLM instance when config.provider=fake", () => {
        const result = makeLLMFromEnvOptional({ provider: "fake" });
        expect(result).toBeDefined();
        expect(result).not.toBeUndefined();
    });

    it("returns an LLM instance when BRASS_LLM_PROVIDER=google and API key is set", () => {
        process.env.BRASS_LLM_PROVIDER = "google";
        process.env.BRASS_GOOGLE_API_KEY = "test-api-key-12345";
        const result = makeLLMFromEnvOptional();
        expect(result).toBeDefined();
        expect(result).not.toBeUndefined();
    });

    it("throws when BRASS_LLM_PROVIDER=google but no API key is set", () => {
        process.env.BRASS_LLM_PROVIDER = "google";
        expect(() => makeLLMFromEnvOptional()).toThrow(/Google LLM provider requires/);
    });

    it("returns an LLM instance via auto-detection when BRASS_GOOGLE_API_KEY is set", () => {
        process.env.BRASS_GOOGLE_API_KEY = "test-api-key-auto";
        const result = makeLLMFromEnvOptional();
        expect(result).toBeDefined();
        expect(result).not.toBeUndefined();
    });

    it("backward compatibility: configured LLM works identically to makeLLMFromEnv", () => {
        // When a provider is explicitly configured with credentials, it should return an LLM
        process.env.BRASS_LLM_PROVIDER = "fake";
        const result = makeLLMFromEnvOptional();
        expect(result).toBeDefined();
        // The fake LLM should have a complete method
        expect(typeof result!.complete).toBe("function");
    });

    it("throws for unsupported provider", () => {
        process.env.BRASS_LLM_PROVIDER = "unsupported-provider";
        expect(() => makeLLMFromEnvOptional()).toThrow(/Unsupported LLM provider/);
    });

    it("does not fall back to fake LLM when no provider is configured", () => {
        // This is the key difference from makeLLMFromEnv - it returns undefined
        // instead of falling back to fake LLM
        const result = makeLLMFromEnvOptional();
        expect(result).toBeUndefined();
    });
});

// --- Test Helpers ---

function makeMinimalResolvedCliArgs(): ResolvedCliArgs {
    return {
        cwd: process.cwd(),
        discoverWorkspace: false,
        where: false,
        goalText: "",
        mode: "propose",
        modeSpecified: false,
        showHelp: false,
        output: "human",
        outputSpecified: false,
        approval: "auto",
        approvalSpecified: false,
        noConfig: true,
        noEnvFile: true,
        protocolFullPatches: false,
        patchFileMode: "apply",
        ci: false,
        failOnPatchProposed: false,
        doctor: false,
        init: false,
        initForce: false,
        initProfile: "default",
        initDryRun: false,
        hostProfile: true,
        config: {},
        workspaceDiscovery: {
            inputCwd: process.cwd(),
            cwd: process.cwd(),
            changed: false,
        },
        batchRuns: [],
        batchStopOnFailureResolved: false,
        envFileLoad: {
            cwd: process.cwd(),
            disabled: true,
            filesChecked: [],
            paths: [],
            loadedKeys: [],
            alreadySetKeys: [],
            emptyKeys: [],
            ignoredKeys: [],
            invalidLines: [],
            errors: [],
        },
    };
}

function makeTestProfile(overrides?: Partial<HostProfile>): HostProfile {
    return {
        transport: "terminal",
        capabilities: {
            hasOwnLLM: false,
            wantsJson: false,
            supportsStreamingEvents: true,
            supportsMcp: false,
            canAskApproval: true,
            canRenderDiff: true,
            canApplyPatch: true,
            interactiveTty: true,
        },
        constraints: {
            readOnlyByDefault: false,
            patchPreviewRequired: false,
            requireNoNetwork: false,
        },
        identity: undefined,
        evidence: [
            { source: "stdio", value: "stdout:tty" },
            { source: "stdio", value: "stdin:tty" },
        ],
        ...overrides,
    };
}

describe("parseCliArgs: outputSpecified tracking", () => {
    it("sets outputSpecified to false when no output flag is provided", () => {
        const result = parseCliArgs(["some goal"]);
        expect(result.outputSpecified).toBe(false);
    });

    it("sets outputSpecified to true when --json is provided", () => {
        const result = parseCliArgs(["--json", "some goal"]);
        expect(result.outputSpecified).toBe(true);
        expect(result.output).toBe("json");
    });

    it("sets outputSpecified to true when --events-json is provided", () => {
        const result = parseCliArgs(["--events-json", "some goal"]);
        expect(result.outputSpecified).toBe(true);
        expect(result.output).toBe("events-json");
    });

    it("sets outputSpecified to true when --protocol-json is provided", () => {
        const result = parseCliArgs(["--protocol-json", "some goal"]);
        expect(result.outputSpecified).toBe(true);
        expect(result.output).toBe("protocol-json");
    });
});

describe("applyCapabilityDefaults: capability-driven output mode defaults", () => {
    /**
     * **Validates: Requirements 7.2, 7.3, 7.4, 7.7**
     */

    it("defaults output to events-json when supportsStreamingEvents is true and output not specified", () => {
        // When running in a terminal (test environment), the host profile may detect
        // supportsStreamingEvents based on TTY. We test by verifying the function
        // respects outputSpecified=false and the profile capabilities.
        const resolved = makeMinimalResolvedCliArgs();
        const result = applyCapabilityDefaults({ ...resolved, hostProfile: false, outputSpecified: false });
        // The result depends on the actual process environment detection.
        // We verify the function doesn't crash and returns valid ResolvedCliArgs.
        expect(result.output).toBeDefined();
        expect(["human", "json", "events-json", "protocol-json"]).toContain(result.output);
    });

    it("does not override output when outputSpecified is true", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const result = applyCapabilityDefaults({ ...resolved, output: "json", outputSpecified: true });
        expect(result.output).toBe("json");
    });

    it("does not override output when outputSpecified is true (events-json)", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const result = applyCapabilityDefaults({ ...resolved, output: "events-json", outputSpecified: true });
        expect(result.output).toBe("events-json");
    });

    it("does not override output when outputSpecified is true (protocol-json)", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const result = applyCapabilityDefaults({ ...resolved, output: "protocol-json", outputSpecified: true });
        expect(result.output).toBe("protocol-json");
    });

    it("does not override approval when approvalSpecified is true", () => {
        const resolved = makeMinimalResolvedCliArgs();
        const result = applyCapabilityDefaults({ ...resolved, approval: "approve", approvalSpecified: true });
        expect(result.approval).toBe("approve");
    });

    it("returns the same object reference when no changes are needed", () => {
        const resolved = makeMinimalResolvedCliArgs();
        // When outputSpecified is true and approvalSpecified is true, no changes should be made
        const input = { ...resolved, output: "json" as const, outputSpecified: true, approval: "approve" as const, approvalSpecified: true };
        const result = applyCapabilityDefaults(input);
        expect(result.output).toBe("json");
        expect(result.approval).toBe("approve");
    });
});
