import { describe, expect, it, vi } from "vitest";
import { asyncSucceed } from "../../../core/types/asyncEffect";
import { Runtime } from "../../../core/runtime/runtime";
import {
    AgentHostConfigError,
    makeAgentLifecycle,
    validateAgentHost,
    withWorkspaceTrust,
} from "../agentHost";
import type { AgentHost, AgentState, PermissionService } from "../types";

const state = {
    goal: { id: "g", cwd: "/workspace", text: "test", mode: "write" },
    phase: "boot",
    observations: [],
    errors: [],
    steps: 0,
} satisfies AgentState;

describe("AgentHost contract", () => {
    it("runs lifecycle shutdown exactly once", () => {
        const lifecycle = makeAgentLifecycle();
        const listener = vi.fn();
        lifecycle.onShutdown(listener);

        lifecycle.shutdown();
        lifecycle.shutdown();

        expect(lifecycle.signal.aborted).toBe(true);
        expect(lifecycle.isShuttingDown()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("rechecks workspace trust before every shell or patch effect", async () => {
        const base: PermissionService = {
            check: () => asyncSucceed({ type: "allow" }) as any,
        };
        const permissions = withWorkspaceTrust(base, { trusted: false });
        const runtime = new Runtime({ env: {} });

        await expect(runtime.toPromise(permissions.check(
            { type: "shell.exec", command: ["git", "status"] },
            state,
        ) as any)).resolves.toMatchObject({ type: "deny", reason: expect.stringContaining("trusted") });
        await expect(runtime.toPromise(permissions.check(
            { type: "fs.readFile", path: "README.md" },
            state,
        ) as any)).resolves.toEqual({ type: "allow" });
    });

    it("rejects malformed construction boundaries", () => {
        expect(() => validateAgentHost({ contractVersion: 2 } as unknown as AgentHost))
            .toThrow(AgentHostConfigError);
        expect(() => validateAgentHost({ contractVersion: 1 } as unknown as AgentHost))
            .toThrow(/requires fs/);
    });
});
