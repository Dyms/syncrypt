# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows
[Semantic Versioning](https://semver.org/) once code ships. Until then, the
*specification* is versioned separately (see `PROJECT.md`).

## [Unreleased]

### Added (M6 — second provider, migration, polish)
- `@syncrypt/provider-webdav`: universal subset over WebDAV (GET/PUT/DELETE/
  PROPFIND, MKCOL on demand, Basic/Bearer, injectable transport) with
  `conditionalWrites: false` — the shared conformance suite and an encrypted
  two-device e2e pass against a REAL WebDAV server (in-process everywhere,
  Apache mod_dav container in CI), proving the ADR-0006 LIST-based manifest
  concurrency on a second protocol.
- Migration preflight in the plugin: warns about enabled/leftover LiveSync,
  Remotely Save, Obsidian Git at unlock — read-only, never auto-fixes;
  migration guide hardened.
- HttpTransport types shared via `@syncrypt/core` (providers stay independent).

### Changed (M6)
- ADR-0017 accepted: direct vault write with MANDATORY read-back verification
  (byte-exact); residual hard-crash risk documented, bounded, never silent.
- Troubleshooting/FAQ folded in M4/M5 findings (clock skew, ADR-0018 mobile
  refusal, wifi-only status, transport/CORS, preflight).

### Added (M5 — Android / mobile)
- Injectable HTTP transport in `@syncrypt/provider-s3` (RFC-0006): signing
  (AwsV4Signer, real `x-amz-content-sha256` payload hash) decoupled from
  dispatch; the plugin routes signed requests through Obsidian `requestUrl()`
  — no webview CORS on desktop or mobile.
- ADR-0018: cross-device KDF creation default (32 MiB/t=4), desktop-only
  opt-in, fail-closed per-device affordability ceiling (mobile: 128 MiB).
- Mobile plugin: `isDesktopOnly: false`; wifi-only + 120 s min-interval
  defaults, foreground-only with best-effort background push; build-time
  guard against Node/Electron API leaking into the bundle.
- Android on-device validation checklist
  (`docs/developer-guide/android-validation.md`).

### Fixed (M5)
- `x-amz-content-sha256` was `UNSIGNED-PAYLOAD` (aws4fetch's S3 default) —
  now a real payload hash; stricter backends/policies accept the requests.

### Added (M4 — Obsidian desktop plugin)
- `@syncrypt/obsidian`: VaultPort over the Obsidian DataAdapter (NFC bridging,
  sync-trash per ADR-0010, profile globs), StateStorePort (ADR-0011), trigger
  scheduler (debounce + min-interval), settings UI with the ADR-0016
  credential warning, passphrase unlock/lock (session-only keys), Safe-Sync
  confirmation modal, conflict notices, human-readable sync log view; esbuild
  bundle → loadable plugin (built in CI).
- ADR-0016 (client secret storage) accepted; threat model updated.

### Changed (M4)
- ADR-0013 accepted and implemented: bulk-change breaker floor
  (`bulkChangeFloor`, default 5) — routine small deletions no longer prompt;
  RFC-0004/0007 and ADR-0010 updated.

### Added (M3 — S3 provider + SDK)
- `@syncrypt/provider-s3`: fetch+SigV4 S3 client (ADR-0015), universal subset,
  honestly PROBED conditional writes, multipart upload with abort-on-failure,
  retries with backoff + jitter, RFC-0007 error taxonomy, credential-free error
  messages. Passes the shared conformance suite against live MinIO in both
  capability modes (CI runs a MinIO service).
- `@syncrypt/sdk`: `openSyncEngine` — storage + vault + passphrase → ready
  `SyncEngine` (keyfile bootstrap included); encrypted two-device e2e over a
  live S3 bucket with ciphertext-only assertion.

### Security (M3, ADR-0014)
- `@syncrypt/crypto` enforces the Argon2id anti-downgrade floor
  (`memoryKiB ≥ 19456`, `iterations ≥ 2`): a seeded-weak keyfile is refused
  fail-closed; threat model updated.

### Added (M2 — encryption)
- `@syncrypt/crypto`: reference `CryptoPort` — Argon2id (hash-wasm) → Master
  Key; HKDF-SHA256 → Content/Manifest/Name keys; AES-256-GCM blobs (format v1,
  header as AAD, fresh random nonces); BLAKE3 plaintext hashing; object keys
  via keyed BLAKE3 under the Name Key; `meta/keyfile-params.json` bootstrap
  (`openVaultCrypto`) with fail-closed, DoS-bounded parsing. No Node-only APIs.
- Benchmark-backed Argon2id defaults (desktop 128 MiB/t=3, mobile profile
  32 MiB/t=4; `scripts/bench-argon2id.mjs`); salt encoding fixed as base64.
- Manual recovery finalized and TESTED: `docs/user-guide/recover.mjs` runs in
  CI against a real encrypted vault; the Python variant verified against real
  output (fork-aware manifest pick, base64 salt).
- Tests: ciphertext-only-storage assertion, passphrase-only device join, wrong
  passphrase / tamper fail-closed, fuzzed encrypted convergence.

### Changed (M2)
- RFC-0005: object-key construction and Argon2id defaults finalized (resolved
  two open questions); cryptography.md records benchmark data and
  poisoned-keyfile bounds.
- `@syncrypt/core/testing` no longer imports vitest; the RFC-0006 conformance
  suite moved to the `@syncrypt/core/testing/conformance` subpath.

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
