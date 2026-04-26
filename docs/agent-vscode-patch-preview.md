# Brass Agent VS Code patch preview

P10 adds the first editor-native write flow for Brass Agent.

The VS Code extension remains a thin client over the CLI. It does not apply
patches directly and does not duplicate agent semantics.

```txt
VS Code command
  -> brass-agent --protocol-json --protocol-full-patches --mode propose
  -> patch.proposed observation
  -> VS Code Webview preview
  -> user clicks Apply Patch
  -> brass-agent --apply-patch-file <temp.diff> --yes
  -> PatchService / permissions / validation stay in src/agent
```

## Why two runs?

The extension first asks the agent to propose a patch. The proposed unified diff
is shown in a webview. If the user approves that exact diff, the extension writes
it to a temporary file and asks the CLI to apply that file.

This avoids the unsafe UX of previewing one patch and then asking the LLM to
regenerate a possibly different patch during apply.

## CLI flags added for editor clients

```bash
brass-agent --protocol-json --protocol-full-patches "fix the failing tests"
```

`--protocol-full-patches` keeps patch payloads untruncated while still compacting
large file contents, prompts, shell output, and LLM responses.

```bash
brass-agent --apply-patch-file ./approved.diff --yes "apply approved patch"
```

`--apply-patch-file` supplies a precomputed unified diff to the agent and runs in
write mode. P13 deliberately disables repair attempts for this exact patch-file path, so the approved diff remains the only diff applied. The diff still flows through:

```txt
AgentGoal.initialPatch
  -> decideNextAction
  -> patch.apply
  -> PermissionService
  -> ApprovalService
  -> PatchService
  -> git apply --check
  -> git apply
  -> validation command discovery
```

`--patch-file PATH` is the lower-level variant that supplies a patch but respects
the selected `--mode`. In `propose` mode it records `patch.proposed`; in `write`
mode it applies through the normal policy path.

## VS Code commands

The extension now contributes:

```txt
Brass Agent: Propose Fix
Brass Agent: Apply Fix
Brass Agent: Inspect Workspace
Brass Agent: Show Last Patch Preview
Brass Agent: Show Output
Brass Agent: Cancel Current Run
```

`Apply Fix` no longer gives the CLI immediate write permissions. It generates a
proposal first, then opens the patch preview. The actual apply only happens after
the user clicks `Apply Patch` in the webview and confirms the modal prompt.

`Show Last Patch Preview` reopens the most recent proposed patch for the current
extension session.

## Boundary invariant

The extension may render and approve a patch, but the CLI remains the authority
for applying it.

```txt
extensions/vscode-brass-agent
  -> temporary diff file
  -> brass-agent --apply-patch-file
  -> src/agent PatchService
  -> src/core runtime
```

The extension never shells out to `git apply` directly.
