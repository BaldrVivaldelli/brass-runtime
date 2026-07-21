import { describe, expect, it } from "vitest";
import {
    approveApprovalRequest,
    hashAgentAction,
    makeApprovalCapability,
    sha256Hex,
    validateApprovalCapability,
} from "../approvalCapability";
import type { ApprovalRequest } from "../types";

const requestFor = (patch: string, issuedAt = 1_000): ApprovalRequest => {
    const action = { type: "patch.apply" as const, patch };
    return {
        action,
        state: {
            goal: { id: "goal-1", cwd: "/workspace", text: "change", mode: "write" },
            phase: "proposing",
            observations: [],
            errors: [],
            steps: 2,
        },
        reason: "Apply the reviewed patch",
        risk: "high",
        defaultAnswer: "reject",
        capability: makeApprovalCapability({
            action,
            workspaceId: "workspace-1",
            goalId: "goal-1",
            issuedAt,
        }),
    };
};

describe("approval capabilities", () => {
    it("uses canonical SHA-256 and binds a grant to the exact patch", () => {
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(hashAgentAction(requestFor("patch-a").action))
            .not.toBe(hashAgentAction(requestFor("patch-b").action));
    });

    it("accepts an echoed, active, operation-scoped capability", () => {
        const request = requestFor("patch-a");
        expect(validateApprovalCapability(approveApprovalRequest(request), request, 1_001))
            .toEqual({ valid: true });
    });

    it("rejects expiry and any hash or workspace substitution", () => {
        const request = requestFor("patch-a");
        expect(validateApprovalCapability(approveApprovalRequest(request), request, 61_001))
            .toEqual({ valid: false, reason: "Approval capability expired" });

        const substituted = requestFor("patch-b");
        expect(validateApprovalCapability(approveApprovalRequest(request), substituted, 1_001))
            .toMatchObject({ valid: false, reason: expect.stringMatching(/capabilityId|operationHash/) });

        const response = approveApprovalRequest(request);
        if (response.type !== "approved") throw new Error("expected approval");
        const forged = {
            ...response,
            capability: { ...response.capability, workspaceId: "workspace-2" },
        } as const;
        expect(validateApprovalCapability(forged, request, 1_001))
            .toEqual({ valid: false, reason: "Approval capability workspaceId mismatch" });
    });
});
