# @syncrypt/core

The pure, platform-agnostic sync engine: manifest model, change detection,
diff/planner, and executor. **No I/O and no Node-only APIs** — everything happens
through injected ports (StoragePort, VaultPort, CryptoPort, ClockPort, LogPort).

Spec: [RFC-0003](../../docs/rfc/RFC-0003-Architecture.md),
[RFC-0004](../../docs/rfc/RFC-0004-Synchronization-Engine.md).

Status: **M1 implemented** (headless, identity crypto) — see [ROADMAP](../../ROADMAP.md).
Encryption lands in M2 (RFC-0005).

- `plan(local, base, remote, opts)` — the pure planner (RFC-0004 decision table).
- `createSyncEngine(config)` — pull / push / sync / dryRun / confirmAndApply / status.
- `@syncrypt/core/testing` — identity CryptoPort (real BLAKE3 hash), in-memory
  ports, and the RFC-0006 provider conformance suite.
