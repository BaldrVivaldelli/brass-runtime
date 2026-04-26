import { asyncSucceed } from "../../core/types/asyncEffect";
import type { ApprovalService } from "../core/types";

export const autoApproveApprovals: ApprovalService = {
    request: () => asyncSucceed({ type: "approved" }) as any,
};

export const makeAutoDenyApprovals = (reason = "Approval denied by non-interactive policy."): ApprovalService => ({
    request: () => asyncSucceed({ type: "rejected", reason }) as any,
});
