# AgentHost contract

`AgentHost` is the versioned, host-independent capability boundary consumed by
the agent. `AgentEnv` remains as a compatibility type alias. New integrations
should construct an `AgentHost` and must not give planner code direct access to
Node, Electron, or VS Code APIs.

## Capabilities

The contract groups:

- workspace identity and trust;
- filesystem/search, shell, patch, and model adapters;
- permissions and approval capabilities;
- versioned workspace/session persistence;
- secrets, diagnostics, telemetry, terminal characteristics, and lifecycle;
- event and per-tool policy hooks.

`makeNodeAgentHost` is the CLI adapter. It owns Node shell/filesystem/patch
services, stable workspace identity, atomic state files, a shutdown signal, and
terminal metadata. `makeVsCodeAgentHost` adapts editor-supplied cancellable
filesystem/search/shell/patch callbacks, Workspace Trust, state,
`SecretStorage`, diagnostics, extension lifecycle, and the editor's approval
UI without importing the `vscode` module into agent core.
`makeVsCodeNativeSearchPilot` composes that host with protocol-v1 private IPC,
rechecks current workspace trust on every index/search call, starts the service
lazily, and connects host shutdown to ordered service drain. The current
standalone extension keeps its explicit protocol-v1 CLI process as the
terminal/degraded-mode adapter; a VS Code fork can use the direct pilot without
giving renderer code or Rust host authority.

## Workspace trust

Trust is checked by `withWorkspaceTrust` on every host-sensitive operation,
not only when a session starts. An untrusted workspace cannot execute shell or
apply/rollback patches even if an earlier UI decision was cached. Path policy
and patch target validation remain additional checks.

## Approval capabilities

An approval is a short-lived capability, not a boolean. The core creates an
exact challenge containing:

- capability, workspace, and goal IDs;
- action type;
- SHA-256 of the canonical action (including exact patch or command);
- issue and expiry timestamps.

The default lifetime is 60 seconds and the hard maximum is five minutes. The
host approval service must return the exact challenge with its approval. Before
tool execution, the core rechecks every field, lifetime, action type, and
operation hash. Editing a patch after preview, changing workspace/goal, or
reusing an expired response invalidates the capability.

Learning-based approval may decide that the host can approve a familiar
operation, but it still returns a newly scoped capability for the current
challenge. It cannot return a reusable blanket grant.

## Persistence

State is split into `session` and `workspace` scopes and addressed by versioned
logical keys such as `agent.workspace-memory.v1`. The Node adapter maps only a
closed key set to `.brass`, validates containment, limits payload bytes, writes
atomically with owner-only file mode, and supports an optional codec for local
encryption. Both adapters wrap new values in a versioned retention envelope,
accept legacy raw values for migration, expire session state after 24 hours by
default, enforce per-record byte quotas, and redact common secret-bearing JSON
fields and bearer credentials before storage. Hosts can override the retention
clock/window and redactor; disabling redaction is an explicit trusted-host
choice. VS Code accepts the same optional codec and should back actual secrets
with `SecretStorage`; secrets never belong in these state payloads.

Every adaptive store in `agent/core` consumes `AgentPersistence`; none imports
Node filesystem/path modules. Error patterns, LLM budget, output preferences,
workspace memory, patch strategy, context budget, validation intensity, and
approval history use the closed v1 key catalog and bounded writes. The public
in-memory adapter exercises the same scope/key/quota/expiry contract in tests.

Persisted structures must remain bounded and redacted. Full prompts and patch
bodies are not persistence metadata. Format changes add a new key/version and
a validated migration; they do not reinterpret old bytes implicitly.

## Lifecycle

`AgentLifecycle.shutdown()` is idempotent, aborts its signal, runs observers
once, and isolates observer failures. Host shutdown must propagate to active
fibers/tools before process or extension disposal.
