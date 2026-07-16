# ADR-0011: Base-manifest persistence via StateStorePort

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0004, RFC-0007

## Context

The engine keeps a device-local **base** — the last manifest this device
successfully synced against (RFC-0004 §Local state). It is a cache, not a source
of truth, but without persistence every process restart forces a full reconcile
and `status()` cannot report a base generation. RFC-0007 §9 left the persistence
home unresolved. The core must stay pure (no I/O, no Node-only APIs), so it
cannot write a file itself.

## Decision

Add an **optional `StateStorePort`** to `SyncEngineConfig` (RFC-0007 §2.5): two
methods, `load(): Promise<Uint8Array | null>` and
`save(data: Uint8Array): Promise<void>`. The engine serializes
`{ version: 1, base: Manifest | null }` as canonical JSON into it after every
successful pull/push. When the port is omitted (or the blob is missing or
unparseable), the engine starts with `base = null` — a full reconcile, safe but
slower, exactly as RFC-0004 prescribes for a lost base.

The incremental-hash cache stays **in-memory** for M1 (losing it costs re-hash
time, never correctness).

## Options considered

- **Persist via `VaultPort.write` into a dot-folder** — pollutes the vault
  surface, entangles state with content, and the vault adapter may exclude
  dot-files; rejected.
- **Require the SDK/client to persist state itself with no port** — every client
  reimplements serialization and atomicity; rejected.
- **Tiny injected `StateStorePort`, opaque blob** — keeps core pure, one obvious
  implementation per platform (file on desktop, plugin storage in Obsidian);
  chosen.

## Consequences

- Core purity preserved; state persistence is one trivial adapter per platform.
- A corrupt/lost state blob degrades to a safe full reconcile — fail-open on a
  cache, fail-closed on data (consistent with RFC-0004).
- The blob is device-local and contains no secrets (manifest metadata only);
  under encryption milestones it may hold plaintext hashes, so clients should
  store it inside the vault's private area, not in shared storage.
