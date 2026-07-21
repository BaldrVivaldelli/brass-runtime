import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNodeAgentHost, makeNodeAgentPersistence } from "../nodeAgentHost";
import { makeConfiguredPermissions } from "../../tools/permissions";

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "brass-agent-host-"));
    temporaryRoots.push(root);
    return root;
};

describe("Node AgentHost", () => {
    it("partitions versioned state and persists workspace data atomically", async () => {
        const root = await temporaryRoot();
        const persistence = makeNodeAgentPersistence(root, { sessionId: "session-a" });

        await persistence.write("workspace", "agent.workspace-memory.v1", "{\"version\":1}");
        await persistence.write("session", "agent.workspace-memory.v1", "session");

        expect(await persistence.read("workspace", "agent.workspace-memory.v1"))
            .toBe("{\"version\":1}");
        expect(await persistence.read("session", "agent.workspace-memory.v1")).toBe("session");
        expect(JSON.parse(await readFile(join(root, ".brass/workspace-memory.json"), "utf8")))
            .toMatchObject({ version: 1, value: "{\"version\":1}" });
    });

    it("expires session state and redacts common secret fields", async () => {
        const root = await temporaryRoot();
        let now = 100;
        const persistence = makeNodeAgentPersistence(root, {
            sessionId: "session-expiring",
            now: () => now,
            sessionRetentionMs: 10,
        });

        await persistence.write("session", "agent.llm-budget.v1", '{"token":"secret-value"}');
        expect(await persistence.read("session", "agent.llm-budget.v1"))
            .toContain("[REDACTED]");
        now = 111;
        expect(await persistence.read("session", "agent.llm-budget.v1")).toBeUndefined();
    });

    it("enforces payload limits before writing", async () => {
        const root = await temporaryRoot();
        const persistence = makeNodeAgentPersistence(root, { defaultMaxBytes: 4 });
        await expect(persistence.write("workspace", "agent.error-patterns.v1", "12345"))
            .rejects.toThrow(/limit is 4/);
    });

    it("builds a host with stable workspace identity and trust-aware permissions", async () => {
        const root = await temporaryRoot();
        const host = makeNodeAgentHost({
            cwd: root,
            permissions: makeConfiguredPermissions(),
            trusted: false,
        });

        expect(host.contractVersion).toBe(1);
        expect(host.kind).toBe("node");
        expect(host.workspace).toMatchObject({ root, trusted: false, id: expect.stringMatching(/^[a-f0-9]{24}$/) });
        expect(host.persistence?.version).toBe(1);
        expect(host.lifecycle?.signal.aborted).toBe(false);
    });
});
