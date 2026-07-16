# CLAUDE.md — working memory for AI coding agents

You are working on **Syncrypt**. Read this first, then the specific RFC for the
subsystem you touch. The **specification is the contract** — implement against it;
do not invent behavior. If a decision is missing, propose an ADR, don't guess.

## What Syncrypt is

A small, explainable, end-to-end-encrypted sync engine for Obsidian vaults across
macOS/Windows/Android over user-owned S3-compatible storage. Files are the source
of truth; a JSON manifest coordinates; only two primitives — **upload / download**.
A storage- and editor-agnostic **platform** (Obsidian is the first client; S3 the
first provider).

## Prime directive

**Syncrypt should never surprise the user.** Every mutation must be explainable in
one sentence (a `ReasonCode`) and previewable via `dryRun`. If an action could
produce an unexpected, unexplainable result → stop and ask.

## Non-negotiable invariants (do not violate)

1. **No silent overwrite.** Both sides changed a file differently ⇒ `conflict`,
   never a blind write.
2. **No auto-merge / no CRDT / no hidden database.**
3. **Storage sees only ciphertext.** Encrypt client-side before upload.
4. **Manifest is the commit point** — published LAST, as an immutable
   per-generation object; safety via `list` + fork detection (works on any S3).
5. **Every applied change has a non-empty `ReasonCode` + human message** (the log).
6. **delete-local goes through trash, never hard-delete** (Safe Sync, ADR-0010).
7. **Fail closed** on `CryptoAuthError` / `ManifestCorrupt` — never apply the data.
8. **`core` and `sdk` must not use Node-only APIs** (the same code runs on Android).
9. **Zero telemetry / no network except the configured storage endpoint.**

## Where the spec lives (read before coding)

- Orientation: [`.ai/project.md`](./.ai/project.md), [`.ai/architecture.md`](./.ai/architecture.md), [`.ai/glossary.md`](./.ai/glossary.md), [`.ai/coding-style.md`](./.ai/coding-style.md)
- **The contract**: [`docs/rfc/RFC-0007-Public-API-and-SDK.md`](./docs/rfc/RFC-0007-Public-API-and-SDK.md) — ports, types, `SyncPlan`, `SyncReport`, `SyncEngine`, errors.
- Engine algorithm: [`docs/rfc/RFC-0004-Synchronization-Engine.md`](./docs/rfc/RFC-0004-Synchronization-Engine.md)
- Architecture & layering: [`docs/rfc/RFC-0003-Architecture.md`](./docs/rfc/RFC-0003-Architecture.md)
- Encryption: [`docs/rfc/RFC-0005-Encryption-Model.md`](./docs/rfc/RFC-0005-Encryption-Model.md)
- Storage contract: [`docs/rfc/RFC-0006-Storage-Provider-API.md`](./docs/rfc/RFC-0006-Storage-Provider-API.md)
- Decisions: [`docs/adr/`](./docs/adr/) · Roadmap: [`ROADMAP.md`](./ROADMAP.md)

## Tech & style

- **TypeScript, `strict: true`.** No implicit `any`, no non-null `!` without cause.
- **`core` is pure and deterministic.** All I/O, time, randomness, and crypto go
  through injected **ports** (`StoragePort`, `VaultPort`, `CryptoPort`, `ClockPort`,
  `LogPort`). Effects live at the edges (providers, client, crypto impl).
- Bytes = `Uint8Array`; times = epoch **seconds**; paths canonical + NFC (ADR-0007).
- Errors: typed taxonomy from RFC-0007 §6. No throwing for control flow across ports.
- Full style rules: [`.ai/coding-style.md`](./.ai/coding-style.md).

## Current milestone — M1 (core, headless)

Build `@syncrypt/core` (pure engine) + `@syncrypt/provider-filesystem` (the
deterministic test backend). **No encryption, no Obsidian yet.** Deliver:

- Manifest model (read/write, generation, tombstones) per RFC-0004/0007.
- Local scanner (hash + mtime) and change detection.
- **Pure `plan(local, base, remote, opts)` → `SyncPlan`** per RFC-0004 decision
  table and RFC-0007 types.
- `push` / `pull` executors against ports; `SyncReport` with reasons.
- Deletion via tombstones + local trash; "pull first" divergence stop; Safe-Sync
  bulk-change circuit breaker (ADR-0010).
- **Tests**: planner golden fixtures + property-based tests asserting **no data
  loss** and **no silent overwrite** over random edit/delete/rename sequences;
  provider conformance suite run against the filesystem provider.

**M1 exit:** two local directories converge correctly across a fuzzed suite with no
loss and no silent overwrite. See ROADMAP for M2+ (encryption, S3, Obsidian…).

## How to work

- **Spec-first.** Every behavior/architecture change references (or adds) an
  RFC/ADR. Put the reference in the commit/PR.
- **Conventional Commits** (`feat:`, `fix:`, `test:`, `docs:`, …), one logical
  change per PR, docs updated alongside behavior.
- **Tests are part of done.** Keep the planner deterministic and covered.
- **Never log secrets.** The sync log is a product surface — reasons, not internals.
- If you spot a better design: propose it with pros/cons/consequences (add/adjust
  an ADR) — don't silently change direction.

## Setup (bootstrap in M1)

Monorepo via npm workspaces (`packages/*`, `packages/providers/*`), Node ≥ 20,
`tsconfig.base.json` at root. Scaffold each package's `package.json`/`tsconfig`
as you implement it; publish under the reserved npm scope **`@syncrypt/*`**.
