# Native service protocol v1

The read-only native search pilot uses newline-delimited JSON over private
stdio. The extension host owns the child process; the renderer never connects
to it. Protocol v1 is fixed by `fixtures/native-ipc-v1.json`, which is decoded
and re-encoded by both TypeScript and Rust tests.

## Session and compatibility

The first request is `hello`. It carries the exact protocol version, client
build, random session ID, random nonce, deadline, and maximum accepted frame.
The service rejects an unknown version, a repeated handshake, or any later
message whose session ID or nonce differs. The response reports the service
build, capabilities, negotiated limits, and `readOnly: true`.

Protocol v1 has no minor-version ambiguity: a peer accepts exactly version 1.
Adding optional capabilities does not alter existing messages; changing a
required field or its meaning requires protocol v2. CLI stdout events remain a
separate terminal/degraded-mode adapter and are not silently interpreted as
native-service frames.

## Requests and lifecycle

Every request contains `id`, `sessionId`, `workspaceId`, `nonce`, absolute
`deadlineMs`, bounded `priority`, `method`, and `params`. The methods are:

- `health`
- `index.replace`
- `search`
- `cancel`
- `shutdown`

Only document IDs and content supplied by the trusted TypeScript host cross the
boundary. The Rust service has no filesystem, network, provider-token, shell,
workspace-write, or approval API. TypeScript checks workspace trust before
every operation.

Index and search requests emit bounded progress, a payload-free
`runtime.boundary` event, one response, and one terminal event. Cancellation is
idempotent. Ordered shutdown cancels active work, waits up to 750 ms for its
terminal events and removal, then reports `drained` and the remaining active
count before the process exits.

The client bounds normal pending work at 16 and reserves 16 additional slots
only for `cancel`/`shutdown`. Saturating data work therefore cannot starve its
own control plane; the total remains bounded.

`NativeServiceClient.eventStream` is a bounded async event stream (128 records
by default, configurable from 16 through 1,024) for extension-host progress
consumers. Repeated progress for one request is coalesced. On saturation it
evicts progress/diagnostics before terminal records and exposes frozen drop/
coalescing counters. The v1 service itself emits at most one progress record
per active operation, with 16 active operations maximum; direct `onEvent`
delivery remains synchronous and terminal lifecycle does not depend on a
stream consumer.

## Limits and redaction

Protocol and service limits are listed in the canonical fixture. The client
rejects oversized frames and validates event objects with an exact key
allow-list. Boundary events contain only operation, timing, byte counts,
result, correlation, queue depth, and stable error code; prompts, document
content, filesystem paths, patches, and secrets are not representable.

Strings use UTF-8 for size/accounting. Document/query matching applies an
explicit ASCII-only case fold and ASCII whitespace tokenization; hit ties use
UTF-8 byte order. Rust and JavaScript therefore remain deterministic for
arbitrary valid Unicode without relying on process locale or different Unicode
case-fold tables.

JSON is deliberate for the pilot. A binary framing protocol is conditional on
profiling that identifies serialization/crossing cost as a bottleneck; it is
not part of protocol v1.
