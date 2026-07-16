# RFC-0004: Synchronization Engine

- **Status:** Accepted
- **Author(s):** Dmitriy (project author)
- **Created:** 2026-07-16
- **Related ADRs:** ADR-0002, ADR-0006, ADR-0007

## Summary

The engine synchronizes a local vault with a remote store using a **manifest** as
the single coordination point. It supports two primitive operations — **upload**
and **download** — plus explicit **deletions** (tombstones). It never merges
content: divergence is surfaced as a **conflict** and the sync stops with
`Please pull first`. This RFC specifies the manifest format, change detection,
the diff/planner algorithm, deletion, conflict handling, object keys, and
triggers.

## Mental model

```
Vault → Watcher/Scanner → "which files changed" → encrypt → Storage
                                     │
                                     └── manifest.json (source of coordination)

Other devices read manifest → download only changed files.
```

No CouchDB. No revision tree. No CRDT. No hidden database. This is deliberately
close to how a plain cloud sync (Dropbox-style) copies files, but explicit and
inspectable.

## The manifest

A manifest is a JSON document describing the intended state of the vault at a
point in time. Conceptually:

```json
{
  "version": 1,
  "generation": 42,
  "device": "windows-01",
  "updatedAt": 1752641180,
  "files": {
    "Projects/ATM.md":        { "hash": "b3:9f2c…", "size": 8123, "mtime": 1752641180 },
    "Daily/2026-07-16.md":    { "hash": "b3:11ab…", "size": 402,  "mtime": 1752641122 },
    "Attachments/diagram.png":{ "hash": "b3:77de…", "size": 51233,"mtime": 1752600000 }
  },
  "tombstones": {
    "Old/Deprecated.md": { "deletedAt": 1752640000, "device": "macbook-01" }
  }
}
```

Field notes:

- **`generation`** — a monotonically increasing integer, incremented on each
  successful publish. It is the basis for divergence detection (see §Conflict).
- **`hash`** — content hash of the **plaintext** file (algorithm prefix included,
  e.g. `b3:` for BLAKE3). Plaintext hashing lets a device detect its own local
  edits without decrypting anything. See RFC-0005 for why the hash is computed on
  plaintext and the privacy implications.
- **`mtime`** — advisory, used for display and tie-breaking hints only. **Hash is
  authoritative** for change detection; mtime is never trusted alone (clocks and
  copies lie).
- **`tombstones`** — deleted paths retained long enough for every device to
  observe the deletion, then garbage-collected (see §Tombstone GC).
- Paths are stored in **normalized form** (ADR-0007) to avoid macOS↔Windows↔
  Android Unicode/case mismatches.

The manifest itself is encrypted at rest (RFC-0005). "The manifest is JSON and
human-readable" means: once decrypted with your passphrase, you can read and edit
it by hand.

## Local state

The engine keeps a small **local base** = the last manifest this device
successfully synced against (its `generation` and file table). This is *cached
state*, not a source of truth; if lost, it is rebuilt by treating the remote
manifest as the base and re-hashing the local vault (a full reconcile, safe but
slower).

## Change detection

To compute **local changes**, scan the vault (respecting the active sync
profile's include/exclude, RFC-0002 FR-1..3) and for each file produce
`(path, hash, size, mtime)`. Compare to the local base:

- path present locally, absent in base → **added**
- path in both, hash differs → **modified**
- path in base, absent locally → **deleted** (candidate tombstone)

Hashing 1,000 notes is cheap; large attachments are hashed incrementally and the
result cached by `(path, size, mtime)` to avoid re-hashing unchanged big files.

## The diff / planner

Inputs: `local` (current scan), `base` (last synced manifest), `remote` (freshly
fetched manifest). Output: an ordered **SyncPlan**.

For each path in the union of the three views, classify by comparing
`local.hash`, `base.hash`, `remote.hash` (absence = ⌀; tombstone = †):

| local | base | remote | Meaning | Planned op |
|-------|------|--------|---------|-----------|
| A | A | A | unchanged everywhere | none |
| B | A | A | changed only locally | **Upload B** |
| A | A | B | changed only remotely | **Download B** |
| B | A | B (=local) | same change both sides | none (reconcile hash) |
| B | A | C | changed differently both sides | **Conflict** |
| ⌀ | A | A | deleted locally | **DeleteRemote (tombstone)** |
| A | A | † | deleted remotely | **DeleteLocal** |
| B | ⌀ | ⌀ | new local file | **Upload B** |
| ⌀ | ⌀ | B | new remote file | **Download B** |
| B | ⌀ | C | independently created same path | **Conflict** |
| ⌀ | A | † | deleted both sides | none (converge tombstone) |

Rules:

- **Never** produce a silent overwrite where both sides changed differently →
  always **Conflict**.
- A **Conflict** op does not modify files. It records both versions in the report
  and (optionally) writes the remote version alongside as
  `name (conflicted copy from <device> <date>).md`, leaving the user to reconcile.
  It does **not** advance the manifest for that path.
- Deletions are expressed as **tombstones** in the manifest, never as the mere
  absence of a key (absence is indistinguishable from "not yet uploaded").

## Publishing (the commit point)

Publication is provider-agnostic — it needs only `list` + `put` + `get`, so it
works on **any** S3-compatible backend (full rationale in ADR-0006). Manifests are
immutable objects named `manifests/<generation>-<deviceId>.json`.

A push proceeds:

1. `list(manifests/)`; let `Gmax` be the highest generation present. Compute the
   plan against that manifest.
2. If `Gmax > base.generation` → someone published since your last pull →
   **stop**: `Sync stopped. Please pull first.` (ADR-0002, RFC-0002 FR-8).
3. Upload all new/changed encrypted objects. Uploads are idempotent (object key
   derives from content, RFC-0005), so re-running is safe.
4. Build the new manifest (`generation = Gmax + 1`) and `put`
   `manifests/<Gmax+1>-<myId>.json`.
5. **Re-list.** If another `<Gmax+1>-<otherId>.json` exists → **fork**: resolve
   deterministically (smallest `deviceId` wins as base; the loser re-plans its
   changes against the winner, surfacing conflicts). No data is lost — both
   manifests and their objects exist. Otherwise the commit succeeded.

Where the provider advertises conditional writes, step 4 additionally uses
create-if-absent to *prevent* forks — an optimization, not a requirement.

Because objects are written before the manifest, a crash mid-push leaves
orphaned-but-harmless objects and an un-advanced manifest; the next run either
completes or re-plans cleanly. Orphan objects are GC'd (see §GC). Immutable
per-generation manifests also give **free history** for point-in-time recovery.

## Pulling

1. Fetch remote manifest.
2. Diff against local base + local scan.
3. Download+decrypt changed objects; apply remote deletions (tombstones) locally;
   surface conflicts.
4. Set local base = remote manifest.

## Conflicts, concretely

Conflicts are expected to be *rare* (the user almost never edits the same note on
two devices simultaneously). When they happen:

- The sync **stops or isolates** the conflicting file — never a blind merge.
- The user sees exactly which file, which two versions, and from which devices.
- Resolution is manual: keep local, keep remote, or merge in the editor, then
  sync again. This is the "you can always repair it by hand" guarantee.

## Object keys

Each file version maps to an encrypted object under `objects/`. Two candidate
strategies (final choice tracked with RFC-0005 privacy analysis):

- **Content-addressed**: key = hash of ciphertext or a keyed hash of plaintext.
  Natural dedup, immutable objects, trivial idempotency; leaks equality of
  contents across paths.
- **Path-mapped**: key = encrypted/HMAC'd path. Simpler mental model; leaks the
  *number* and *change frequency* of distinct paths.

Default recommendation: **content-addressed with a per-vault keyed hash**
(HMAC-BLAKE3 under the vault key) so identical plaintext does not reveal itself
to the storage operator and objects stay immutable. See RFC-0005 §Object keys.

## Deletion & tombstone GC

- A delete writes a tombstone `{ deletedAt, device }` into the manifest and
  removes the local file on other devices at next pull.
- Tombstones are retained for a **grace window** (default: 30 days) and then
  garbage-collected, along with the now-unreferenced encrypted objects.
- GC only removes objects unreferenced by the current manifest **and** older than
  the grace window, so an interrupted push never deletes live data.

## Safe Sync: data-safety guard rails

The project exists because a prior tool once mass-deleted and duplicated ~1,000
notes. Tombstones and "stop on divergence" prevent silent *overwrites*, but a
*bulk accident* (a bad delete, a broken profile, a corrupted scan) still needs
containment. Safe Sync is **on by default** (ADR-0010) and adds four rails:

1. **Pre-delete local trash.** Before removing a local file (because it was
   deleted remotely), move a copy into `.obsidian/sync-trash/` — a local folder
   that is itself never synced — instead of hard-deleting. Instant recovery.
2. **Deferred remote deletion.** Deletes are tombstones with a grace window
   before object GC (see above), never immediate hard-deletes.
3. **Version retention.** Keep the last *K* previous encrypted versions of a
   changed file (default 3). Cheap given immutable per-generation manifests
   (ADR-0006); enables point-in-time recovery.
4. **Bulk-change circuit breaker.** If a single sync would delete or overwrite
   more than a threshold — default **> 20 files or > 10 % of the vault**,
   whichever is smaller — **pause and require explicit confirmation**, showing the
   full list first. This catches "something went very wrong" before it propagates
   to other devices.

Thresholds are configurable; defaults are conservative. `.obsidian/sync-trash/`
is in the default exclude set.

## Triggers

- **On app open** → `pull`.
- **On app close / background** → `push`.
- **Manual "Sync now"** → `pull` then `push`.
- **While active (debounced auto-sync)** → after edits settle, `push` changed
  files (and periodically `pull`). This is what keeps devices current *during* a
  work session, not only at open/close.
- **Dry-run** → compute and print the plan without executing (RFC-0002 FR-14).

### Resource-aware auto-sync (mobile-friendly)

Auto-sync while active must never drain battery or mobile data. It is governed by
guards, all configurable, with mobile-safe defaults:

- **Debounce**: wait `N` seconds of edit inactivity before syncing (default 15 s)
  and coalesce bursts into one sync.
- **Minimum interval**: at most one auto-sync every `M` seconds (default 120 s on
  mobile). Manual "Sync now" ignores this.
- **Delta only**: only changed files transfer (already true by design), and a
  no-change sync costs a single `list` + manifest `get` — a few KB.
- **Network policy**: `wifi-only` option (default on for mobile); optionally skip
  auto-sync on metered connections or below a battery threshold.
- **Foreground only on mobile**: Android/iOS auto-sync runs only while Obsidian is
  in the foreground. Syncrypt does **not** assume a background daemon; a `push` is
  attempted on background/close as a best-effort within the app lifecycle.

Desktop may use tighter intervals (it is not battery/data constrained). See the
[compatibility matrix](../architecture/overview.md#compatibility-matrix).

## Determinism & testing

- The planner is a **pure function** of `(local, base, remote)`. It is tested
  with golden fixtures and property-based tests over random edit/delete/rename
  sequences, asserting **no data loss** and **no silent overwrite** invariants.
- The executor is tested against in-memory Vault and Storage ports.

## Unresolved questions

- Final object-key strategy (with RFC-0005).
- Default tombstone grace window and whether it is user-configurable.
- Whether to keep N historical manifests for point-in-time recovery (a cheap,
  attractive durability feature — likely post-1.0).
