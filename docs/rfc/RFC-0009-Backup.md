# RFC-0009: Local Backup & Snapshots

- **Status:** Draft
- **Author(s):** Dmitriy (idea) · Architecture: Claude
- **Created:** 2026-07-16
- **Target:** post-1.0. Not part of the v1 scope.
- **Related:** RFC-0003 (StorageProvider), RFC-0005, ADR-0010, provider-filesystem,
  docs/user-guide/manual-recovery.md

## Summary

A `BackupService` (in the SDK, driven by the client) that makes **full local
backups** on a schedule or on demand, in two complementary modes: a plaintext
**vault snapshot** and an **encrypted repository mirror**. Backups are strictly
read-only with respect to live data, fail loudly, and are verified after writing.

## Motivation

"Never lose data" is the prime directive. Sync keeps devices consistent but is not
a backup — a mistaken mass edit propagates. A local backup gives an independent,
restorable copy (the "3-2-1" story: device + remote + local backup).

## Modes

### A. Vault snapshot (plaintext)

Copy the profile-selected vault files to a destination (a timestamped folder or a
`.zip`), e.g. `backups/syncrypt-YYYYMMDD-HHMMSS/`. Human-readable, offline, needs
no key. Best for "give me my notes as plain files, now."

### B. Encrypted repository mirror

Incrementally copy the remote store (`manifests/`, `objects/`, `meta/`) into a
**local filesystem StorageProvider**. Because objects are content-addressed and
immutable (RFC-0005), only new objects transfer. The result is an offline,
encrypted, self-contained repo that is restorable by:
- pointing Syncrypt at the local mirror as its provider, or
- running the documented `recover.mjs` / Python script (manual-recovery.md).

This reuses the provider abstraction — a mirror is a provider→provider copy.

## Triggers & scheduling

- **"Backup now"** command (both modes).
- **Scheduled**: desktop uses a timer (Obsidian `registerInterval`); mobile is
  foreground/manual only (no background daemon — consistent with RFC-0004).
- **Retention**: keep the last *N* backups or *N* days; GC older ones. **Never
  delete the newest**, and never delete a backup that is currently being written.

## Safety

1. **Read-only w.r.t. live data.** Backup logic never deletes or mutates vault
   files or the remote store. A bug in backup must not endanger the source.
2. **Loud failure.** A failed/partial backup surfaces an error and is not counted
   as a successful backup (so retention never GCs a good one in favor of a broken
   one).
3. **Verify after write.** Snapshot: verify file count/size (or a hash manifest).
   Mirror: verify object count and that the newest manifest is present and
   decrypts.
4. **Encryption boundary unchanged.** Mode B stores ciphertext; Mode A stores
   plaintext to a local path the user chose — warn that Mode A output is
   unencrypted.

## Non-goals

- Cloud-to-cloud backup (that is just adding another provider).
- Deduplicated/versioned archive formats (borg/restic-style) — Mode B already
  gets incrementality for free from content-addressing.

## Open questions

- Default destination and retention values per platform (desktop vs mobile).
- Should Mode A optionally encrypt the zip (passphrase-derived) for a portable
  encrypted snapshot?
- Expose backup status/history in the sync log view?

## Consequences

- Strong durability story with little new machinery (Mode B is mostly wiring the
  filesystem provider as a mirror target).
- Adds a scheduling surface and retention policy to the client.
