# @syncrypt/core

The pure, platform-agnostic sync engine: manifest model, change detection,
diff/planner, and executor. **No I/O and no Node-only APIs** — everything happens
through injected ports (StoragePort, VaultPort, CryptoPort, ClockPort, LogPort).

Spec: [RFC-0003](../../docs/rfc/RFC-0003-Architecture.md),
[RFC-0004](../../docs/rfc/RFC-0004-Synchronization-Engine.md).

Status: not yet implemented — see [ROADMAP M1](../../ROADMAP.md).
