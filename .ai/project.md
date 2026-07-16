# AI Context: Project

Machine-readable orientation for AI coding agents (Claude Code, Codex, etc.).
Read this first, then the specific RFC for the subsystem you are implementing.

## What this is
Syncrypt: cross-platform (macOS/Windows/Android) end-to-end-encrypted sync engine
for Obsidian vaults over user-owned S3-compatible storage. Files are the source of
truth; a JSON manifest coordinates; only two primitives: upload/download.

## Prime directive
**Syncrypt should never surprise the user.** Every invariant below serves this.
If an action could produce an unexpected, unexplainable result → stop and ask.

## Non-negotiable invariants (do not violate)
1. No silent overwrite. Both-sides-changed ⇒ Conflict, never a blind write.
2. No auto-merge / no CRDT.
3. Storage sees only ciphertext. Encrypt client-side before upload.
4. Manifest is the commit point; publish LAST, atomically (conditional write).
5. Every applied change has a one-sentence reason in the sync log ("no magic").
6. Any file is hand-recoverable with the passphrase.
7. Zero telemetry / no network except the configured storage endpoint.
8. `core` and `sdk` must not use Node-only APIs (Android runs the same code).

## Where things live
- Specs: `docs/rfc/`  · Decisions: `docs/adr/`  · Diagrams: `docs/architecture/`
- Engine (pure): `packages/core`  · Facade: `packages/sdk`
- S3 backend: `packages/providers/s3`  · Obsidian client: `packages/obsidian-plugin`

## Implementation order (see ROADMAP.md)
M1 core (no crypto, local provider) → M2 encryption → M3 S3 → M4 desktop plugin →
M5 Android → M6 migration + 2nd provider.

## How to contribute code
Every behavior/architecture change references an RFC/ADR. If a decision isn't
recorded, propose an ADR first. Keep `core` pure and deterministic; put effects
behind ports (StoragePort, VaultPort, CryptoPort, ClockPort, LogPort).
