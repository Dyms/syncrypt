# @syncrypt/core

The pure, platform-agnostic sync engine: manifest model, change detection,
diff/planner, and executor. **No I/O and no Node-only APIs** — everything happens
through injected ports (StoragePort, VaultPort, CryptoPort, ClockPort, LogPort).

Status: **implemented.** Real encryption is injected via
[`@syncrypt/crypto`](../crypto/README.md); the engine itself is crypto-agnostic.

- `plan(local, base, remote, opts)` — the pure planner.
- `createSyncEngine(config)` — pull / push / sync / dryRun / confirmAndApply / status.
- `@syncrypt/core/testing` — identity CryptoPort (real BLAKE3 hash), in-memory
  ports, and the RFC-0006 provider conformance suite.
