import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../../../core/runtime/runtime";
import { makeConfiguredPermissions } from "../../tools/permissions";
import { autoApproveApprovals } from "../../tools/approvals";
import { makeVsCodeAgentHost, type VsCodeAgentHostApi } from "../vscodeAgentHost";
import { runAgent } from "../../core/runAgent";

const apiFixture = (overrides: Partial<VsCodeAgentHostApi> = {}) => {
    const state = new Map<string, string>();
    let dispose: (() => void) | undefined;
    const api: VsCodeAgentHostApi = {
        workspace: { id: "workspace-vscode", root: "/workspace", trusted: true },
        readFile: async (path) => `content:${path}`,
        exists: async () => true,
        searchText: async () => [{ path: "src/a.ts", line: 1, text: "match" }],
        applyPatch: async () => ({ changedFiles: ["src/a.ts"] }),
        rollbackPatch: async () => ({ changedFiles: ["src/a.ts"] }),
        state: {
            read: async (key) => state.get(key),
            write: async (key, value) => { state.set(key, value); },
            remove: async (key) => { state.delete(key); },
        },
        secrets: {
            get: async () => undefined,
            set: async () => undefined,
            delete: async () => undefined,
        },
        onDidDispose: (listener) => {
            dispose = listener;
            return () => { dispose = undefined; };
        },
        ...overrides,
    };
    return { api, state, dispose: () => dispose?.() };
};

describe("VS Code AgentHost adapter", () => {
    it("adapts editor APIs to cancellable effects and scoped state", async () => {
        const fixture = apiFixture();
        const host = makeVsCodeAgentHost({
            api: fixture.api,
            permissions: makeConfiguredPermissions(),
            approvals: autoApproveApprovals,
        });
        const runtime = new Runtime({ env: host });

        await expect(runtime.toPromise(host.fs.readFile("/workspace/README.md") as any))
            .resolves.toBe("content:/workspace/README.md");
        await host.persistence?.write("workspace", "agent.workspace-memory.v1", "state");
        expect(JSON.parse(fixture.state.get("workspace:agent.workspace-memory.v1")!))
            .toMatchObject({ version: 1, value: "state" });
        await expect(host.persistence?.read("workspace", "agent.workspace-memory.v1"))
            .resolves.toBe("state");
        expect(host.kind).toBe("vscode");
        expect(host.secrets).toBe(fixture.api.secrets);
    });

    it("propagates cancellation and extension disposal", () => {
        let receivedSignal: AbortSignal | undefined;
        const fixture = apiFixture({
            readFile: (_path, signal) => {
                receivedSignal = signal;
                return new Promise(() => undefined);
            },
        });
        const host = makeVsCodeAgentHost({
            api: fixture.api,
            permissions: makeConfiguredPermissions(),
            approvals: autoApproveApprovals,
        });
        const callback = vi.fn();
        const cancel = (host.fs.readFile("/workspace/a.ts") as any).register(host, callback);

        cancel?.();
        expect(receivedSignal?.aborted).toBe(true);
        expect(callback).not.toHaveBeenCalled();

        fixture.dispose();
        expect(host.lifecycle?.signal.aborted).toBe(true);
    });

    it("denies shell effects in untrusted workspaces before reaching the adapter", async () => {
        const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
        const fixture = apiFixture({
            workspace: { id: "workspace-vscode", root: "/workspace", trusted: false },
            exec,
        });
        const host = makeVsCodeAgentHost({
            api: fixture.api,
            permissions: makeConfiguredPermissions(),
            approvals: autoApproveApprovals,
        });
        const state = {
            goal: { id: "g", cwd: "/workspace", text: "status", mode: "autonomous" as const },
            phase: "boot" as const,
            observations: [],
            errors: [],
            steps: 0,
        };
        const runtime = new Runtime({ env: host });

        await expect(runtime.toPromise(host.permissions.check(
            { type: "shell.exec", command: ["git", "status"] },
            state,
        ) as any)).resolves.toMatchObject({ type: "deny" });
        expect(exec).not.toHaveBeenCalled();
    });

    it("executes the agent core without importing the VS Code module", async () => {
        const fixture = apiFixture({
            readFile: async () => JSON.stringify({ name: "fixture", scripts: {} }),
            exists: async () => false,
            searchText: async () => [],
        });
        const host = makeVsCodeAgentHost({
            api: fixture.api,
            permissions: makeConfiguredPermissions(),
            approvals: autoApproveApprovals,
        });
        const runtime = new Runtime({ env: host });
        const state = await runtime.toPromise(runAgent(runtime, {
            id: "vscode-host-run",
            cwd: "/workspace",
            text: "preview supplied patch",
            mode: "propose",
            llmAvailable: false,
            initialPatch: [
                "diff --git a/src/a.ts b/src/a.ts",
                "--- a/src/a.ts",
                "+++ b/src/a.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
            ].join("\n"),
        }));

        expect(state.phase).toBe("done");
        expect(state.observations.some((observation) => observation.type === "patch.proposed")).toBe(true);
    });
});
