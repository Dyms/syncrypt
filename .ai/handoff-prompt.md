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
