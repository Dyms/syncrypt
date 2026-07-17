# ROADMAP — Syncrypt

Milestone-based, not date-based. Each milestone is shippable and testable on its
own. The ordering encodes dependencies: durability and correctness come before
convenience.

Legend: ☐ todo · ◐ in progress · ☑ done

---

## M0 — Specification (current)

Goal: a complete, internally consistent specification an engineer (or an AI
coding agent) can implement without further design decisions.

- ☑ RFC-0001 Vision
- ☑ RFC-0002 Product Requirements
- ☑ RFC-0003 Architecture
- ☑ RFC-0004 Synchronization Engine
- ☑ RFC-0005 Encryption Model
- ☑ RFC-0006 Storage Provider API
- ☑ Threat model + cryptography rationale
- ☐ Foundational decisions ratified (ADR-0001…0009 moved from Proposed → Accepted)

**Exit criteria:** tag `spec-v1.0`.

## M1 — Core engine (headless) — ✅ done

Goal: a `@syncrypt/core` package that can sync a plain directory to an
in-memory / local-disk provider, no encryption, no Obsidian.

- ☑ Manifest model + read/write
- ☑ Local scanner (hash + mtime) and change detection
- ☑ Diff algorithm (local vs remote manifest → plan of operations)
- ☑ `push` / `pull` executors
- ☑ Deletion via tombstones
- ☑ "Please pull first" safe-stop on divergent manifest
- ☑ Deterministic, fully unit-tested (golden manifests, property tests)

**Exit criteria:** two local directories converge correctly across a fuzzed set
of edit/delete/rename sequences, with no data loss and no silent overwrite.
*Met: `packages/providers/filesystem/test/e2e.two-devices.test.ts` (plus the
in-memory fuzz in `packages/core/test/engine.fuzz.test.ts`).*

## M2 — Encryption — ✅ done

Goal: end-to-end encryption per [RFC-0005](./docs/rfc/RFC-0005-Encryption-Model.md).

- ☑ Argon2id key derivation from passphrase
- ☑ AES-256-GCM per-file encryption with random nonces
- ☑ Encrypted manifest / path handling decision implemented
- ☑ Key file format + versioned crypto header
- ☑ Tamper detection (GCM auth tag) surfaced as a clear error
- ☑ Round-trip and cross-device decryption tests

**Exit criteria:** storage backend holds only ciphertext; a wrong passphrase
fails safely; corrupted blobs are detected, not silently accepted.
*Met: `packages/crypto/test/e2e.encrypted-sync.test.ts` (ciphertext-only
assertion, passphrase-only join, fail-closed) and
`packages/crypto/test/recovery.test.ts` (manual recovery, FR-13).*

## M3 — S3 provider — ✅ done

Goal: `@syncrypt/provider-s3` implementing the StorageProvider contract against
S3-compatible backends. Validated against several vendors (AWS S3, MinIO, and the
user's own S3) to prove portability — **the user never has to verify capabilities
themselves**; the provider probes and adapts.

- ☑ put / get / list / delete / stat (the universal subset)
- ☑ Manifest concurrency via LIST + immutable generation objects (works anywhere)
- ☑ Optional conditional-write fast path when the vendor supports it (probed)
- ☑ Multipart upload for large attachments
- ☑ Retry / backoff / partial-failure semantics
- ☑ Provider conformance test suite (shared across providers)

**Exit criteria:** core + encryption run end-to-end against a live S3 backend and
pass the conformance suite.
*Met against live MinIO (RELEASE.2025-09-07), both capability modes; encrypted
SDK e2e in `packages/sdk/test/e2e.s3-encrypted.test.ts`. Validation against
AWS S3 / the user's own S3 endpoint remains a manual step (same env vars).*

## M4 — Obsidian plugin (desktop) — ◐ code complete, in field validation

Goal: usable plugin on macOS + Windows Obsidian desktop.

- ☑ Vault adapter (read/write via Obsidian API)
- ☑ Sync triggers: on open (pull), on close (push), manual "Sync now"
- ☑ Sync profiles (include/exclude), Safe Mode default
- ☑ Human-readable sync log ("what happened and why")
- ☑ Settings UI (provider config, passphrase handling — ADR-0016)
- ☑ Safe-Sync confirmation UX + ADR-0013 breaker floor
- ☐ Field validation: daily use on two desktops (manual)

**Exit criteria:** daily-drivable on two desktops sharing one vault.
*Automated part met (adapter/scheduler/integration tests, loadable build in
CI); the daily-use criterion is a manual sign-off on real machines.*

## M5 — Android

Goal: the plugin works within Obsidian mobile constraints on Android.

- ☐ Validate crypto + S3 within the mobile plugin sandbox (no Node APIs)
- ☐ Manual + on-open/close sync (background execution is limited — see
  [compatibility matrix](./docs/architecture/overview.md#compatibility-matrix))
- ☐ Battery / data-usage sanity

**Exit criteria:** three-device loop (Windows ↔ macOS ↔ Android) converges.

## M6 — Migration & polish

- ☐ Migration guide + tooling from Self-hosted LiveSync
- ☐ Troubleshooting + FAQ hardened from real usage
- ☐ Conformance for a second provider (WebDAV or Cloudflare R2) to prove the
  abstraction

## Post-1.0 ideas (not committed)

**More storage providers (no engine changes):** Cloudflare R2 · Backblaze B2 ·
MinIO · Wasabi · WebDAV (Nextcloud) · Dropbox · Google Drive · OneDrive · local
folder / external drive.

**More clients (one core, many editors):** Logseq · VS Code · Foam · Zettlr ·
other Markdown editors · a headless **CLI** (also great for hand-recovery and
testing) · a **Docker** / self-hosted runner for scheduled sync.

**Other:** multiple vaults · hardware keys · per-folder selective sync ·
versioned snapshots / point-in-time recovery (cheap given immutable manifests) ·
optional size padding for metadata privacy · optional compression.

All deferred so they can be added later via RFCs without breaking the v1 concept.
