# Handoff prompt for Claude Code — M1 (core engine)

Paste the block below into Claude Code, run from the repository root. It assumes
`CLAUDE.md` and the `docs/` specification are present (they are).

---

```text
You are the implementer for Syncrypt. The specification is the contract — build to
it, don't invent behavior. If a needed decision is missing, propose an ADR instead
of guessing.

FIRST, read these in order and confirm you understand the invariants:
- CLAUDE.md
- .ai/project.md, .ai/architecture.md, .ai/coding-style.md, .ai/glossary.md
- docs/rfc/RFC-0007-Public-API-and-SDK.md   (the API/types contract)
- docs/rfc/RFC-0004-Synchronization-Engine.md (the algorithm + decision table)
- docs/rfc/RFC-0003-Architecture.md          (layering, ports)
- docs/adr/ADR-0002, ADR-0006, ADR-0007, ADR-0010

GOAL — Milestone M1 (headless core, NO encryption, NO Obsidian):
Implement `@syncrypt/core` (pure engine) and `@syncrypt/provider-filesystem`
(deterministic local-folder StorageProvider used as the test backend).

SCOPE:
1. Bootstrap the monorepo: npm workspaces, Node >=20, root tsconfig.base.json is
   present — add per-package package.json + tsconfig that extend it. Packages are
   published under the reserved scope @syncrypt/*. Set up a test runner (vitest)
   and lint (eslint + typescript-eslint, strict).
2. Implement the RFC-0007 types and ports (StoragePort, VaultPort, CryptoPort,
   ClockPort, LogPort). For M1, CryptoPort has a pass-through/identity impl (no
   real crypto yet) and hashing uses a real content hash.
3. Implement the manifest model (parse/serialize, generation, tombstones, history).
4. Implement the local scanner (hash + mtime, incremental cache) and change
   detection against a base manifest.
5. Implement the PURE planner `plan(local, base, remote, opts) -> SyncPlan` exactly
   per the RFC-0004 decision table and RFC-0007 types (ReasonCode on every op).
6. Implement executors: pull, push, sync, dryRun, confirmAndApply, status — per
   RFC-0007 §7, using the ports. Publishing uses immutable per-generation manifests
   + list + fork detection (ADR-0006). delete-local routes through VaultPort.trash
   (ADR-0010). Divergence -> pullFirst. Bulk-change over threshold ->
   requiresConfirmation.
7. Implement @syncrypt/provider-filesystem implementing StoragePort against a local
   directory, plus a VaultPort filesystem adapter for tests.
8. TESTS (part of done):
   - Planner: golden fixtures for every row of the decision table + property-based
     tests over random edit/delete/rename sequences, asserting the invariants
     NO DATA LOSS and NO SILENT OVERWRITE.
   - Provider conformance suite run against provider-filesystem.
   - End-to-end: two local "devices" (two vault dirs + one shared storage dir)
     converge across a fuzzed sequence.

HARD INVARIANTS (must hold; see CLAUDE.md):
- No silent overwrite (both-sides-changed => conflict). No auto-merge/CRDT.
- Manifest is the commit point, published last, immutable per generation.
- core/ and sdk/ use NO Node-only APIs; effects only in providers/adapters.
- Every applied change carries a ReasonCode + human message. Fail closed on errors.
- Never log secrets.

WAY OF WORKING:
- Start by proposing a short implementation plan and the package/file layout for my
  approval BEFORE writing code.
- Then implement in small, reviewable steps, each with tests. Use Conventional
  Commits and reference the RFC/ADR in each commit.
- If you find a better design than the spec, stop and propose it with
  pros/cons/consequences as an ADR — do not silently diverge.

M1 EXIT CRITERIA:
Two local directories converge correctly across the fuzzed suite with zero data
loss and zero silent overwrite; provider-filesystem passes the conformance suite;
`npm test` and lint are green.

Begin with the plan.
```

---

## Notes for the human (you)

- Run Claude Code from `C:\Users\dsbog\Projects\Syncrypt` (the repo root).
- Approve the plan it proposes before it writes code; it is instructed to ask.
- Keep encryption (M2) and the S3 provider (M3) out of this first pass — M1 is
  deliberately crypto-free so the sync logic is proven in isolation.
- When M1 is green, use the M2 prompt below.

---

# Handoff prompt for Claude Code — M2 (encryption)

M1 is complete and green. Now implement end-to-end encryption per RFC-0005 behind
the existing `CryptoPort`, without changing the sync logic.

```text
You are the implementer for Syncrypt, continuing from a green M1. The spec is the
contract; propose an ADR rather than guessing if a decision is missing.

READ FIRST: CLAUDE.md; docs/rfc/RFC-0005-Encryption-Model.md;
docs/security/cryptography.md; docs/architecture/threat-model.md;
docs/user-guide/manual-recovery.md; docs/rfc/RFC-0007 (CryptoPort);
docs/adr/ADR-0003.

GOAL — Milestone M2: real client-side encryption. Storage must hold ONLY
ciphertext. The engine, planner, and providers do not change behavior.

SCOPE:
1. New package @syncrypt/crypto (reference impl of CryptoPort), browser+mobile
   safe: WebCrypto (SubtleCrypto) for AES-256-GCM and HKDF-SHA256; a vetted
   WASM/native lib for Argon2id and BLAKE3. No Node-only APIs.
2. Key hierarchy (RFC-0005): Argon2id(passphrase, salt, params) -> MasterKey;
   HKDF -> ContentKey / ManifestKey / NameKey. Keys are memory-only, never logged
   or persisted in plaintext.
3. Blob format v1: magic "SYNC" | version(1) | alg(1=AES-256-GCM) | nonce(12,
   random per encryption) | ciphertext | tag(16); header bound as AAD. hash() is
   BLAKE3 over PLAINTEXT; objectKeyFor = HMAC-BLAKE3(NameKey, contentHash).
4. Encrypt content objects with ContentKey and the manifest with ManifestKey.
   Upload keyfile-params.json (salt + KDF params, non-secret) so a new device
   derives the same keys from the passphrase alone.
5. Fail closed: any GCM tag failure / wrong passphrase -> CryptoAuthError; never
   apply the data (assert this in tests).
6. Finalize and TEST the manual-recovery reference script in
   docs/user-guide/manual-recovery.md against real engine output (fix the salt
   encoding placeholder). It MUST decrypt a real manifest + objects with only the
   passphrase.
7. Benchmark and set Argon2id defaults (desktop; note a mobile profile). Record
   final params + salt encoding in RFC-0005 / cryptography.md.

TESTS (part of done):
- Round-trip encrypt/decrypt for content and manifest.
- Wrong passphrase and tampered blob both raise CryptoAuthError (fail-closed).
- Cross-device: device B derives keys from passphrase + keyfile-params and decrypts
  device A's data.
- objectKeyFor is deterministic and reveals neither path nor plaintext.
- Storage-only-ciphertext assertion: no plaintext bytes appear in any stored object
  or in the stored manifest.
- The manual-recovery script restores a vault end-to-end.
- All M1 tests stay green (planner tests may keep the identity CryptoPort; engine
  e2e now runs with real crypto).

INVARIANTS (unchanged): storage sees only ciphertext; fail closed on crypto errors;
core/ and sdk/ use no Node-only APIs (crypto lives in @syncrypt/crypto, injected);
never log secrets; no telemetry.

WAY OF WORKING: propose a short plan + package layout for approval BEFORE coding;
implement in small tested steps with Conventional Commits referencing RFC-0005 /
ADR-0003; if you find a better design, propose an ADR (pros/cons/consequences).

M2 EXIT: storage holds only ciphertext; wrong passphrase fails safely; tamper is
detected; a new device decrypts from the passphrase; the manual-recovery script
works; npm test + lint + typecheck green.

Begin with the plan.
```

---

# Handoff prompt for Claude Code — M4 (Obsidian plugin, desktop)

M1–M3 are green (core, crypto, S3 provider, sdk). Now build the first real client:
the Obsidian desktop plugin. Mobile (Android) is M5 — build mobile-aware but do not
target it yet.

```text
You are the implementer for Syncrypt, continuing from green M1–M3. The spec is the
contract; propose an ADR rather than guessing if a decision is missing.

READ FIRST: CLAUDE.md; docs/rfc/RFC-0003 (layering), RFC-0004 (triggers, Safe Sync),
RFC-0007 (SyncEngine, VaultPort, StateStorePort); docs/adr/ADR-0007, ADR-0010,
ADR-0011, ADR-0012, ADR-0013; docs/architecture/threat-model.md; docs/ui/.

GOAL — Milestone M4: a daily-drivable Obsidian DESKTOP plugin (macOS + Windows)
that syncs one vault through @syncrypt/sdk over S3, with a transparent UI.

SCOPE:
1. @syncrypt/obsidian: VaultPort over the Obsidian API (Vault DataAdapter:
   read/writeBinary, list, stat, remove, rename). trash() moves files to
   .obsidian/sync-trash/ — a Syncrypt-controlled, NEVER-synced folder (ADR-0010) —
   NOT Obsidian's own trash. Bridge canonical<->native paths with NFC normalization
   (ADR-0007; macOS may hand NFD).
2. StateStorePort impl: persist the base manifest between sessions (plugin data or a
   file) so a restart does not force a full reconcile (ADR-0011).
3. Triggers (RFC-0004): pull on layout-ready; best-effort push on unload/quit;
   a "Sync now" command; debounced while-active sync on vault-modify events with the
   resource-aware guards (min interval, debounce). Desktop may be aggressive; keep
   the knobs so M5 can tighten them.
4. Settings UI: choose provider + config (endpoint, region, bucket, prefix,
   forcePathStyle, credentials); sync profile (include/exclude, ADR-0010 defaults);
   Safe Sync toggles. Passphrase unlock flow.
5. SECRET STORAGE — decide explicitly and record as an ADR (propose first):
   Obsidian persists plugin settings to data.json in PLAINTEXT and has no OS
   keychain API. Recommended default: the PASSPHRASE is never persisted — prompt on
   unlock each session, keep only the derived key in memory (optional "remember for
   this session"). S3 credentials are stored in data.json (unavoidable: they are
   needed to fetch the keyfile before any key exists) — warn the user in the UI and
   recommend least-privilege, single-bucket credentials. Update the threat model.
6. Human-readable sync log: a view/panel rendering SyncReport entries (one line per
   file: ReasonCode + message). This is a product surface — never show secrets.
7. Safe Sync UX: when a plan returns requiresConfirmation (bulk-change breaker),
   show a modal listing every affected file; on approval call confirmAndApply.
   Surface conflicts (conflicted-copy files) with a clear notice.
8. ADR-0013: move it to Accepted and implement the breaker FLOOR (default 5) so a
   single delete on a small vault does not nag; keep the mass-change protection.

INVARIANTS: never surprise the user — every applied change is in the log with a
reason; delete-local via trash; storage sees only ciphertext (the plugin never
handles plaintext beyond the vault it already owns); no secrets in logs; no
telemetry; keep code portable toward the mobile build (no Node-only APIs that would
block M5).

WAY OF WORKING: propose a short plan + the secret-storage ADR for approval BEFORE
coding. Keep the Obsidian API behind VaultPort so the adapter is thin and
unit-testable against a mock DataAdapter (heavy logic is already tested in core).
Conventional Commits referencing the RFC/ADR. Better design -> ADR with
pros/cons/consequences.

M4 EXIT: two desktops (macOS + Windows) sharing one vault over S3 converge in daily
use; conflicts and Safe Sync confirmations are surfaced; the sync log is readable;
passphrase is session-only; npm test + lint + typecheck green; the plugin builds
into a loadable Obsidian plugin.

Begin with the plan and the secret-storage ADR.
```

---

# Handoff prompt for Claude Code — M5 (Android / Obsidian mobile)

M1–M4 are green. Make the plugin work on Obsidian mobile (Android), and fix the
transport gap that also blocks the desktop live-S3 test.

```text
You are the implementer for Syncrypt, continuing from green M1–M4. Spec is the
contract; propose an ADR rather than guessing if a decision is missing.

READ FIRST: CLAUDE.md; RFC-0006 (S3 notes — injectable transport / CORS), RFC-0005
(KDF), RFC-0004 (resource-aware triggers); docs/architecture/overview.md
(compatibility matrix); ADR-0014, ADR-0017.

GOAL — Milestone M5: the Obsidian plugin runs on Android within mobile limits;
three-device loop (Windows <-> macOS <-> Android) converges within a sane
battery/data budget.

SCOPE:
1. INJECTABLE TRANSPORT (do this first — it also unblocks the M4 live-S3 test).
   provider-s3 must accept an injectable HTTP transport (default: global fetch).
   Inside Obsidian (desktop AND mobile) renderer fetch is subject to CORS and
   S3/MinIO don't send permissive CORS headers, so raw fetch is blocked. Decouple
   signing from dispatch: use aws4fetch sign() to build a signed request, then send
   it via the transport. The Obsidian client supplies a transport backed by
   Obsidian's requestUrl() (bypasses CORS). Add a unit test for the transport seam.
2. isDesktopOnly=false in the plugin manifest. Validate the whole stack in the
   mobile webview: Argon2id WASM + BLAKE3 + WebCrypto AES-GCM/HKDF load and run; no
   Node-only API sneaks in (the build already forbids it).
3. KDF CROSS-DEVICE PARAMS (decide + record an ADR). The vault-wide Argon2id params
   live in keyfile-params.json and every joining device MUST use them. A phone
   joining a vault created with the 128 MiB desktop profile must run 128 MiB
   Argon2id — which can OOM/lag low-end Android. Resolve: make the DEFAULT
   vault-creation profile cross-device-safe (mobile-affordable), and offer the
   heavier desktop profile only as an explicit opt-in ("desktop-only vault"), or
   prompt at creation. Never let a device silently pick params another device can't
   afford. Stay within the ADR-0014 floor.
4. Resource-aware triggers for mobile (RFC-0004): wifi-only default ON, longer min
   interval, foreground-only, NO background daemon; best-effort push on
   background/close. Keep desktop behavior unchanged (parametrized).
5. Battery/data sanity: delta-only transfers (already), debounce + min interval,
   no polling loops; a no-change sync stays a single list + manifest get.

TESTS: transport-seam unit test; KDF-params selection/guard test (mobile can't be
forced into unaffordable params; joining uses the vault's params); keep all
M1–M4 suites green. Real-device Android testing is manual — provide an on-device
checklist.

INVARIANTS: storage sees only ciphertext; no Node-only APIs anywhere in shipped
code; never log secrets; no telemetry; never surprise the user.

WAY OF WORKING: land the transport fix first (unblocks desktop + mobile), then
mobile validation, then the KDF-params ADR + guard. Conventional Commits
referencing RFC/ADR. Better design -> ADR with pros/cons/consequences.

M5 EXIT: three-device loop converges over live S3 via requestUrl transport (no CORS
errors); Android stays within battery/data budget; KDF params are cross-device-safe;
npm test + lint + typecheck + plugin build green.

Begin with the plan and the KDF-params ADR.
```

---

# Handoff prompt for Claude Code — M6 (migration + 2nd provider → spec-v1.0)

M1–M5 are green. M6 proves the storage abstraction with a genuinely different
backend, hardens migration, and readies the 1.0 spec tag.

```text
You are the implementer for Syncrypt, continuing from green M1–M5. Spec is the
contract; propose an ADR rather than guessing if a decision is missing.

READ FIRST: CLAUDE.md; RFC-0006 (StorageProvider, capabilities, injectable
transport); ADR-0006 (LIST-based concurrency); docs/user-guide/
migration-from-livesync.md; ADR-0017 (open — write atomicity).

GOAL — Milestone M6: a second, protocol-different storage provider that passes the
SAME conformance suite; hardened LiveSync migration; and spec-v1.0 readiness.

SCOPE:
1. @syncrypt/provider-webdav (recommended over R2 — it actually exercises the
   abstraction: different protocol, capabilities().conditionalWrites=false, no
   multipart). Implement the universal subset over WebDAV:
   - get=GET, put=PUT, delete=DELETE, stat=PROPFIND(Depth:0);
   - list(prefix)=PROPFIND(Depth:1) walked recursively (Depth:infinity is often
     disabled); create intermediate collections with MKCOL as needed;
   - auth: Basic and Bearer; injectable transport (Obsidian requestUrl on clients,
     same seam as S3);
   - capabilities(): conditionalWrites=false, objectVersioning=false,
     maxSinglePutBytes tuned (no multipart — single PUT, stream large bodies).
   It MUST pass the shared provider conformance suite with conditionalWrites=false,
   against a REAL WebDAV server (dockerized Nextcloud or a webdav container) in CI.
   This is the proof that manifest concurrency works with no conditional writes.
2. Migration from Self-hosted LiveSync: harden docs/user-guide/
   migration-from-livesync.md from real usage; add a preflight check that detects
   leftover LiveSync artifacts / two sync systems pointed at one vault and warns
   (never auto-fix). Keep "start clean" as the safe default.
3. Polish: fold findings from the M4/M5 manual validations into FAQ +
   troubleshooting. Resolve ADR-0017 (write atomicity): either implement
   temp(excluded)+atomic rename-over if the Obsidian DataAdapter supports it, or
   record the accepted fallback with the documented residual risk — move it off
   "Proposed".
4. spec-v1.0 readiness: verify every Accepted ADR is implemented and cited; RFC
   statuses correct; CHANGELOG complete; ROADMAP M6 checked; tag readiness note.
   Do NOT tag — list what remains for me to cut spec-v1.0.

TESTS: WebDAV provider passes the shared conformance suite (both live + mocked);
a two-device encrypted e2e over live WebDAV converges (ciphertext-only); migration
preflight unit tests; all M1–M5 suites stay green.

INVARIANTS: storage sees only ciphertext; manifest concurrency stays LIST-based and
correct with conditionalWrites=false; no Node-only APIs in shipped client code;
never log secrets; no telemetry; never surprise the user.

WAY OF WORKING: propose a short plan (and the ADR-0017 resolution) for approval
BEFORE coding. Small tested steps, Conventional Commits referencing RFC/ADR. If a
WebDAV quirk forces a design choice, record it as an ADR (pros/cons/consequences).

M6 EXIT: provider-webdav passes conformance + encrypted e2e against a live WebDAV
server with conditionalWrites=false; migration guide hardened + preflight; ADR-0017
resolved; spec-v1.0 readiness checklist produced; npm test + lint + typecheck +
builds green.

Begin with the plan.
```

---

# Handoff prompt for Claude Code — M7 (Beta release & BRAT distribution)

M1–M6 are code-complete and green. Make the Obsidian plugin installable from
GitHub via BRAT so the field validation (Windows -> S3 -> macOS) can run on real
machines with a real network S3.

```text
You are the implementer for Syncrypt, continuing from green M1–M6. Spec is the
contract; propose an ADR rather than guessing if a decision is missing.

READ FIRST: CLAUDE.md; packages/obsidian-plugin/*; docs/spec-v1.0-readiness.md;
ROADMAP.md; docs/developer-guide/android-validation.md.

GOAL — Milestone M7: a BRAT-installable beta release of the Obsidian plugin, with
a release pipeline and packaging tests. This enables (and becomes) the M4/M5 field
validation via real installs instead of manual dist copying.

SCOPE:
1. Plugin manifest + versions. Finalize packages/obsidian-plugin/manifest.json:
   id "syncrypt", name "Syncrypt", version "1.0.0-beta.1", minAppVersion (pick a
   sane recent Obsidian, e.g. 1.5.0), description, author, authorUrl, and
   isDesktopOnly=false. Add versions.json { "1.0.0-beta.1": "<minAppVersion>" }.
   Mirror manifest.json + versions.json at the REPO ROOT (BRAT and the future
   community store read these); add a test/CI check that root and package copies
   stay identical.
2. Build output. esbuild produces main.js (CJS, Obsidian format) + copies
   manifest.json (+ styles.css if any) into a dist/ ready for release. Keep the
   existing mobile/Node-API build guard.
3. Release workflow (.github/workflows/release.yml): on a pushed tag matching the
   plugin version (e.g. "1.0.0-beta.1" or "v1.0.0-beta.1"), run typecheck + lint +
   tests + build, then create a GitHub Release and upload main.js, manifest.json,
   versions.json, and styles.css (if present) as assets. Do NOT publish npm here.
4. Packaging tests (expand the suite):
   - manifest.json is valid: required fields present, id === "syncrypt",
     isDesktopOnly === false, version matches versions.json and the package
     version; root copy === package copy.
   - the built main.js loads under a mock Obsidian `App`/`Plugin` and exports a
     default class extending Plugin; onload/onunload wire up without throwing.
   - reassert the bundle guard (no require("node:*")/fs/electron) on the RELEASE
     bundle specifically.
5. Docs: docs/user-guide/install-via-brat.md — exact BRAT steps for Windows and
   macOS (install BRAT, "Add beta plugin" -> Dyms/syncrypt, enable, configure S3,
   unlock, Sync now). Update the M4 two-desktop and M5 Android checklists to use
   BRAT install. Note least-privilege S3 creds and that requestUrl handles CORS.

CONSTRAINTS: this milestone does not change engine/crypto/provider behavior — it is
packaging, CI, and docs. Keep all M1–M6 suites green. The human cuts the actual
GitHub Release (tag); the workflow fills its assets.

WAY OF WORKING: propose a short plan (manifest fields, version scheme, workflow
outline) for approval BEFORE coding. Conventional Commits. If BRAT needs a repo
layout choice (root manifest vs release-only), record it as a short ADR.

M7 EXIT: pushing a version tag produces a GitHub Release whose assets BRAT can
install; packaging tests + build guard green; install-via-brat.md written;
field checklists updated. npm test + lint + typecheck + build green.

Begin with the plan.
```
