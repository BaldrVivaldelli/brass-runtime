# Native compatibility changelog

This log records externally relevant compatibility for the WASM ABI, native
service protocol, and their TypeScript adapters. A breaking field, opcode,
sentinel, framing, authentication, or lifecycle change requires a new major
contract version and an entry here before release.

## Current matrix

| Surface | Current | Accepted by TypeScript | Compatibility rule |
| --- | ---: | --- | --- |
| WASM ABI | 1 | exactly 1 | Unknown newer versions fail in strict mode; `auto` may use its diagnosed TS fallback. |
| Native service IPC | 1 | exactly 1 | Unknown versions fail handshake; no implicit downgrade. |
| Runtime boundary event | 1 | exactly 1 | Exact event key allow-list; payload-bearing fields are rejected. |
| AgentHost | 1 | 1 or omitted for legacy hosts | New required capabilities need a new contract version. |
| Agent persistence envelope | 1 | 1 plus validated legacy raw values | New stored shapes use a new versioned key/envelope and migration. |

## 2026-07-21

- Established WASM ABI v1: little-endian 32-bit words, bounded program and
  patch encodings, handshake/capabilities, typed errors, reset and free.
- Established native IPC v1 over private newline-delimited JSON stdio with
  session ID, nonce, exact protocol negotiation, deadlines, priority,
  cancellation, terminal events, bounded messages, health, and ordered drain.
- Established payload-free `runtime.boundary` v1 for `ts-wasm`, `ts-ipc`, and
  `ipc-rust` legs.
- Fixed `fixtures/native-lifecycle-v1.json` and `fixtures/native-ipc-v1.json`
  as cross-language compatibility corpora.
- Read-only native editor search was promoted after two final-worktree reports
  passed every predeclared gate. `auto` remains native-first with deterministic
  TS fallback. The editor-specific binary is separately checksummed and is not
  a required component of the generic npm runtime package.
