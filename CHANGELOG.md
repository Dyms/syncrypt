# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows
[Semantic Versioning](https://semver.org/) once code ships. Until then, the
*specification* is versioned separately (see `PROJECT.md`).

## [Unreleased]

### Added (M1 — core engine, headless)
- `@syncrypt/core`: RFC-0007 types/ports/errors/reasons; manifest model with
  canonical serialization and fail-closed parsing; NFC path canonicalization
  (ADR-0007); scanner with incremental hash cache; **pure planner** per the
  RFC-0004 decision table; `SyncEngine` (pull/push/sync/dryRun/confirmAndApply/
  status) with the ADR-0006 publish protocol (manifest last, LIST fork
  detection), Safe-Sync trash/retention/circuit-breaker (ADR-0010), and
  conflict materialization (ADR-0012).
- `@syncrypt/core/testing`: identity CryptoPort with real BLAKE3 hashing,
  in-memory ports, and the RFC-0006 provider conformance suite.
- `@syncrypt/provider-filesystem`: local-directory StoragePort (both
  conditional-write and universal modes) + filesystem VaultPort.
- Tests: planner golden fixtures + property-based invariants (no loss, no
  silent overwrite), engine behavior suite, fuzzed two-device convergence in
  memory and over real directories (M1 exit criterion).
- Monorepo tooling: npm workspaces, strict TypeScript, typescript-eslint, vitest.

### Changed (spec, M1 implementation review)
- RFC-0004: decision table completed with edit-vs-delete rows (edit survives).
- RFC-0007: `ReasonCode.ConflictEditDelete`, optional `StateStorePort`
  (ADR-0011) in `SyncEngineConfig`.
- ADR-0011 (base-state persistence) and ADR-0012 (conflict materialization,
  edit-beats-delete) accepted.
- RFC-0006/ADR-0006 erratum: conditional writes cannot *prevent* cross-device
  forks with per-device manifest keys; re-LIST detection is the guarantee.

### Added
- Initial specification: RFC-0001…RFC-0006.
- Architecture Decision Records ADR-0001…ADR-0009.
- Threat model and cryptography rationale.
- Repository scaffold: docs, `.ai/` agent context, `.github/` templates,
  `packages/` skeleton.

### Changed (spec revision after review)
- ADR-0006: manifest concurrency redesigned to work on **any** S3 (immutable
  generation objects + LIST fork-detection); conditional writes now optional.
- RFC-0004: resource-aware while-active auto-sync (mobile battery/data guards).
- ADR-0008: license set to **MIT**.
- RFC-0001 / ROADMAP: platform vision made explicit — storage- and editor-
  agnostic core; future clients (Logseq, VS Code, Foam, Zettlr, CLI, Docker).

### Added (handoff readiness)
- `CLAUDE.md` working-memory for AI coding agents; `.ai/handoff-prompt.md` (M1 kickoff).
- `RFC-0007` Public API & SDK contract (ports, types, SyncPlan/SyncReport, SyncEngine).
- `docs/user-guide/manual-recovery.md` reference decryption script.
- Repo structure expanded to the reference layout (developer-guide, sdk, ui, images,
  examples, tests, scripts, design; providers r2/webdav/filesystem; CODE_OF_CONDUCT).
- `tsconfig.base.json`, `.nvmrc`; RU localization of user-facing docs + i18n policy.
- Prime directive "Syncrypt should never surprise the user"; ADR-0010 Safe Sync.
- ADR-0008 MIT license finalized; ADR-0009 name Syncrypt + @syncrypt scope reserved.
