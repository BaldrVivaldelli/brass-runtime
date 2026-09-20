export function buildReleaseGuardrailPlan(configuration) {
  const operations = [];
  for (const [branchName, branch] of Object.entries(configuration.branches)) {
    operations.push({
      endpoint: `repos/${configuration.repository}/branches/${branchName}/protection`,
      payload: {
        required_status_checks: {
          strict: branch.requiredStatusChecks.strict,
          checks: branch.requiredStatusChecks.checks.map((check) => ({
            context: check.context,
            app_id: check.appId,
          })),
        },
        enforce_admins: branch.enforceAdmins,
        required_pull_request_reviews: branch.requirePullRequest
          ? {
              dismiss_stale_reviews: branch.dismissStaleReviews,
              require_code_owner_reviews: false,
              required_approving_review_count: branch.requiredApprovingReviewCount,
              require_last_push_approval: false,
            }
          : null,
        restrictions: null,
        required_linear_history: false,
        allow_force_pushes: branch.allowForcePushes,
        allow_deletions: branch.allowDeletions,
        block_creations: false,
        required_conversation_resolution: branch.requireConversationResolution,
        lock_branch: false,
        allow_fork_syncing: true,
      },
    });
  }
  for (const [environmentName, environment] of Object.entries(configuration.environments)) {
    operations.push({
      endpoint: `repos/${configuration.repository}/environments/${environmentName}`,
      payload: {
        wait_timer: environment.waitTimerMinutes,
        prevent_self_review: environment.preventSelfReview,
        reviewers: environment.reviewers.map((reviewer) => ({ type: reviewer.type, id: reviewer.id })),
        deployment_branch_policy: {
          protected_branches: environment.protectedBranchesOnly,
          custom_branch_policies: !environment.protectedBranchesOnly,
        },
      },
    });
  }
  return {
    schemaVersion: 1,
    repository: configuration.repository,
    githubApiVersion: configuration.githubApiVersion,
    operations,
  };
}
