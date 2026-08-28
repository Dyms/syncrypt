# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows
[Semantic Versioning](https://semver.org/) once code ships. Until then, the
*specification* is versioned separately (see `PROJECT.md`).

## [Unreleased]

## [1.0.0-beta.6] — 2026-08-28

### Fixed
- **DATA LOSS: a device with a narrower profile deleted other devices' files**
  (ADR-0022). `list()` only reports what the local profile covers, so the
  engine could not tell "the user deleted this" from "this device does not
  carry that kind of file" — and tombstoned the difference for everyone. A
  phone that excluded `**/*.pdf` deleted the PDFs on the desktop; a phone with
  Obsidian-settings sync off deleted the settings files the desktop synced.
  Files went to each device's sync-trash rather than vanishing, but the effect
  was still a deletion nobody asked for.

  `VaultPort` now answers `syncable(path)`, and the planner uses it: a path
  outside this device's profile is never downloaded here and never counted as a
  local deletion — it stays in the manifest for the devices that do carry it.
  Regression tests cover both shapes (differing sync profiles, differing
  config-sync settings).

## [1.0.0-beta.5] — 2026-08-28

### Fixed
- **A storage that cannot answer "does this object exist?" no longer fails the
  sync.** That probe only skips re-uploading identical content; objects are
  addressed by their content hash, so the only thing a rewrite could ever
  replace is identical bytes. A transport failure during the probe is now
  logged and the upload proceeds — only a truly unreachable storage fails, and
  it fails at the upload, where it means something. When the probe could not
  answer, the upload additionally asks for **create-if-absent** wherever the
  backend supports conditional writes, so "never overwrite blindly" holds by
  construction; a precondition failure is read as "already stored".
- **`stat` degrades further when needed**: HEAD → byte-range GET → a one-key
  LIST. The last step is the same request shape the engine already uses to read
  the manifest, so it works wherever anything works at all. The chosen strategy
  sticks for the session, and definitive answers (404, 403) are never retried in
  another shape. Failures now name the strategy — `stat(head)`, `stat(range)`,
  `stat(list)` — so a log line says which request actually broke.

## [1.0.0-beta.4] — 2026-08-28

### Fixed
- **Sync on Android no longer fails with "network error … Stream closed".**
  Obsidian's `requestUrl()` on Android cannot issue a HEAD request — it expects
  a response body and throws `IOException Stream closed` — and `stat` used HEAD
  for every object, so a mobile sync died on the first file while the desktop
  was fine. `stat` now detects a transport-level HEAD failure once and switches
  to a byte-range GET (`Range: bytes=0-0`, size read from `Content-Range`) for
  the rest of the session: one request, one byte of transfer, same information.
  Real answers are untouched — a 404 stays "not found", a 403 stays "access
  denied", and if the range GET fails too the original network error is what
  the user sees. The Obsidian transport also stops demanding a body from
  responses that have none (HEAD, 204, 304).

## [1.0.0-beta.3] — 2026-08-22

### Added
- **Russian interface** (ADR-0021). Settings, modals, status bar, notices and
  the sync log — including the per-file reasons — follow Obsidian's own
  language, and a Language setting can pin English or Russian regardless.
  Reason codes stay stable in the engine; only the phrasing is translated, so
  switching language re-renders existing log history too. Command names follow
  the language chosen at startup.
- **Device enrollment from Settings**: "Share connection" and "Add this device
  from a ticket" now have buttons in a Devices section, not only entries in the
  command palette.
- **"What matches now"**: a button that counts the files the current profile
  patterns would sync — locally, without keys, without touching storage.
- **Obsidian settings sync** (RFC-0008), off by default and opt-in per item:
  appearance, editor options, hotkeys, themes, CSS snippets, the core- and
  community-plugin lists, and — chosen plugin by plugin — each plugin's
  `data.json`. Plugins known to keep API keys in their settings are flagged in
  the list and warn on the way in. Three things can never be synced whatever
  the settings say: Syncrypt's own `data.json` (it holds the storage keys,
  ADR-0016), the window layout, and the sync-trash. Plugin CODE is never
  synced — installing and updating plugins stays the store's job, so a second
  writer can never roll a version back.

### Fixed
- **The unlock dialog closes as soon as the vault opens.** It used to wait for
  the whole on-open sync before closing, so on a large vault it sat on
  "Checking…" for minutes while the log already said "unlocked". The dialog now
  waits only for the key check; the first sync runs in the background with its
  progress in the status bar.
- **A wrong passphrase now says so.** The unlock dialog stays open, clears the
  field and explains the failure inline instead of closing silently and leaving
  the only trace in the sync log. The check happens at unlock time: the new
  `SyncEngine.verifyAccess()` reads and decrypts the published manifest without
  scanning the vault, so a wrong passphrase fails in the dialog rather than
  halfway through the first sync. Storage problems are reported as storage
  problems — an unreachable bucket or rejected access keys no longer read as
  "wrong passphrase" — and a transient network failure does not block the
  unlock at all: the vault opens, editing works, and the next sync verifies.

### Changed
- The stored-credentials note is phrased for humans and rendered as a normal
  description instead of a red alert, and it appears only once keys are
  actually stored.
- The "What gets synced" section explains itself: it states up front that
  dot-folders (`.obsidian` with its settings, plugins and themes) are never
  synced, and the pattern fields carry worked examples.
- Language auto-detection reads both `localStorage["language"]` and
  `moment.locale()`, and Settings shows what each source reported and which
  language won — a wrong guess is now visible instead of mysterious.

## [1.0.0-beta.2] — 2026-08-22

### Changed
- The released plugin bundle is **81% smaller** — 916 KB → 174 KB. Release
  builds no longer embed an inline sourcemap, which accounted for 742 KB of
  the previous bundle. Nothing about what the plugin does changed; run
  `npm run build:dev -w @syncrypt/obsidian` (or set `NODE_ENV=development`)
  to get the sourcemap back for local debugging.

### Added (1.0.0-beta.1 — BRAT release, status indicator, device enrollment)
- BRAT-installable beta: finalized plugin manifest + `versions.json` (mirrored
  at the repo root), a release workflow that fills a GitHub Release with
  `main.js`/`manifest.json`/`versions.json` on a version tag after the full
  test gate, and packaging tests (manifest/version consistency, mirror
  byte-identity, the built bundle loads under a mock Obsidian and stays free
  of Node/Electron APIs).
- Honest sync-status indicator: status bar + settings block derive from one
  tested pure function; `synced ✓` appears only when everything truly is
  synced, otherwise `pending` explains why; live progress, offline/error/
  conflict states; click = Sync now.
- Connection ticket for adding devices: all storage settings + credentials in
  one string encrypted under the vault passphrase (Argon2id + AES-256-GCM,
  fresh salt, fail-closed on wrong passphrase or tampering; optional
  creds-less mode). "Share connection" / "Add this device from a ticket"
  commands; EN+RU setup docs updated.

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
