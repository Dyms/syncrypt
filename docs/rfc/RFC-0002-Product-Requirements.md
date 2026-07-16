# RFC-0002: Product Requirements

- **Status:** Accepted
- **Author(s):** Dmitriy (project author)
- **Created:** 2026-07-16
- **Related ADRs:** ADR-0001, ADR-0004

## Summary

The functional and non-functional requirements Syncrypt v1 must satisfy, derived
directly from the target user's real workflow. Requirements use RFC 2119 keywords
(**MUST**, **SHOULD**, **MAY**).

## Target user & context

- One person, one logical Obsidian vault.
- Devices: **macOS** (MacBook), **Windows**, **Android**.
- Roughly **1,000+ notes** plus attachments (images, PDFs, Canvas, Excalidraw).
- Owns **S3-compatible** object storage (initially REG.RU S3) and is satisfied
  with it.
- **Almost never** edits the same note on two devices at the same time.
- Does **not** need sub-second propagation.
- Overriding priority: **do not lose data.**
- Strong preference: the solution can be **repaired by hand**.

## Functional requirements

### Content coverage

- **FR-1 (MUST)** Sync all vault **content**: `*.md`, `Attachments/`, `Canvas/`
  (`*.canvas`), and Excalidraw files.
- **FR-2 (SHOULD)** Sync **selected** configuration from `.obsidian/` (e.g.
  `snippets/`, `community-plugins.json`, chosen plugin data), driven by an
  explicit include/exclude profile.
- **FR-3 (MUST)** Exclude volatile/machine-specific state by default:
  `.obsidian/cache`, `.obsidian/workspace.json`, `.obsidian/workspaces.json`,
  and similar. See [configuration guide](../user-guide/configuration.md).

### Sync semantics

- **FR-4 (MUST)** Provide exactly two primitive operations: **upload (push)** and
  **download (pull)**. No third "merge" primitive.
- **FR-5 (MUST)** Detect local changes by content **hash** and modification time,
  compared against a stored **manifest**.
- **FR-6 (MUST)** Transfer only changed files (delta by manifest), not the whole
  vault.
- **FR-7 (MUST)** Represent deletions explicitly (tombstones), so a delete on one
  device propagates without ambiguity and can be reviewed.
- **FR-8 (MUST)** When the remote manifest has diverged from the local base
  (someone else pushed since your last pull), **stop and require a pull first**
  rather than overwriting. Surface it as `Sync stopped. Please pull first.`
- **FR-9 (MUST NOT)** Perform automatic content merging or CRDT resolution.
  Conflicts are surfaced for the user to resolve by hand.
- **FR-10 (SHOULD)** Offer sync triggers: on Obsidian **open** (pull), on
  **close** (push), and a manual **"Sync now"** command.

### Transparency & recoverability

- **FR-11 (MUST)** Maintain a human-readable **sync log**: for every file acted
  on, one line stating the action and the reason.
- **FR-12 (MUST)** Keep the manifest human-readable (JSON) and stored alongside
  the data so state can be inspected without the app.
- **FR-13 (MUST)** Ensure any file can be **restored by hand** from storage
  (given the passphrase) without Syncrypt running.
- **FR-14 (SHOULD)** Support a **dry-run** that prints the plan without executing.

### Security

- **FR-15 (MUST)** Encrypt all content **client-side** before upload
  (see RFC-0005).
- **FR-16 (MUST)** Derive keys from a user passphrase; never transmit the
  passphrase or key.
- **FR-17 (MUST)** Detect tampering/corruption of downloaded data and refuse to
  apply it.

### Configuration & portability

- **FR-18 (SHOULD)** Support named **sync profiles** (YAML) with `include` /
  `exclude` globs.
- **FR-19 (SHOULD)** Be **provider-agnostic** via a StorageProvider interface
  (RFC-0006); S3 is the first implementation.
- **FR-20 (MUST)** Default to **Safe Mode** (conservative behavior: prefer
  stopping over destructive action).
- **FR-21 (MUST)** Provide **Safe Sync guard rails** (ADR-0010), on by default:
  (a) move locally-deleted files to `.obsidian/sync-trash/` instead of hard-
  deleting; (b) defer remote deletions via tombstones + grace window; (c) retain
  the last *K* versions of changed files; (d) a **bulk-change circuit breaker**
  that pauses for confirmation when a sync would delete/overwrite more than a
  configurable threshold (default > 20 files or > 10% of the vault).

## Non-functional requirements

- **NFR-1 Durability:** No silent data loss or duplication. This is the primary
  metric.
- **NFR-2 Determinism:** Given the same inputs, the sync plan is identical and
  testable.
- **NFR-3 Explainability:** Every action maps to a one-sentence reason.
- **NFR-4 Portability:** Core logic runs on desktop (Node/Electron) and within
  Obsidian mobile constraints on Android (no Node-only APIs in shared code).
- **NFR-5 Performance:** A no-change sync of a ~1,000-note vault completes with a
  small, bounded number of storage requests (ideally one manifest read).
  Changed-file transfer scales with the size of the change, not the vault.
- **NFR-6 Privacy:** Zero telemetry. Storage backend sees only ciphertext (and,
  pending RFC-0005, minimal metadata).
- **NFR-7 Operability:** Runs against commodity S3-compatible storage with no
  additional server the user must maintain.

## Explicit non-goals (v1)

- Real-time / sub-second synchronization.
- Multi-user or concurrent editing of the same note.
- Automatic conflict resolution / merge.
- A hidden local database as the source of truth.
- A proprietary or opaque on-disk/on-storage format.
- Mandatory self-hosted services beyond the object storage.

## Acceptance criteria (v1)

1. Three-device loop converges with no data loss across a fuzzed edit/delete/
   rename suite.
2. Storage holds only ciphertext; hand-restoration works with the passphrase.
3. Divergent-manifest scenarios stop safely with a clear message.
4. Every applied change is present in the sync log with a reason.
