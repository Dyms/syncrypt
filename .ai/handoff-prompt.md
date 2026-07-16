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
- When M1 is green, the M2 prompt is: "Implement RFC-0005 encryption behind the
  existing CryptoPort; storage must hold only ciphertext; add round-trip and
  wrong-passphrase tests."
