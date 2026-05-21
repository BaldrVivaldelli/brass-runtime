import { asyncSucceed } from "../../core/types/asyncEffect";
import type { ApprovalService } from "../core/types";
import type { LearningConfig } from "../core/approvalLearning/types";
import type { HistoryStore } from "../core/approvalLearning/store";
import { makeFileHistoryStore } from "../core/approvalLearning/store";
import { makeLearningApprovalService } from "../core/approvalLearning/learningService";

export const autoApproveApprovals: ApprovalService = {
    request: () => asyncSucceed({ type: "approved" }) as any,
};

export const makeAutoDenyApprovals = (reason = "Approval denied by non-interactive policy."): ApprovalService => ({
    request: () => asyncSucceed({ type: "rejected", reason }) as any,
});

/**
 * Optionally wrap an existing ApprovalService with the learning layer.
 * When `approvalLearning` config is provided, the learning layer intercepts
 * requests and auto-approves high-confidence actions.
 *
 * Returns the original service unchanged when no config is provided.
 */
export const withApprovalLearning = async (
    underlying: ApprovalService,
    options: {
        readonly cwd: string;
        readonly config?: Partial<LearningConfig>;
        readonly store?: HistoryStore;
    },
): Promise<ApprovalService> => {
    if (!options.config) return underlying;

    const store = options.store ?? makeFileHistoryStore(options.cwd);
    return makeLearningApprovalService({
        underlying,
        store,
        config: options.config,
    });
};
