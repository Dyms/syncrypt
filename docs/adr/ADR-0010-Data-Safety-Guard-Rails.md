# ADR-0010: Data-safety guard rails ("Safe Sync")

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0002, RFC-0004, ADR-0002

## Context

The project exists because a prior sync (Self-hosted LiveSync) once **deleted and
duplicated ~1,000 notes**. Tombstones and "stop on divergence" prevent silent
overwrites, but they do not, by themselves, protect against a *bulk* accident
(a bad delete, a broken profile, a corrupted scan) propagating to every device.
The original design conversation called for an explicit **"Safe Sync"** mode with
concrete guard rails, on by default. These are cheap to implement and directly
target the exact failure that motivated the project.

## Decision

Ship these guard rails in v1, enabled by default (part of Safe Mode):

1. **Pre-delete local trash.** Before deleting a local file (because it was
   deleted remotely), move a copy to `.obsidian/sync-trash/` (a local, never-
   synced folder) instead of hard-deleting. The user can recover instantly.
2. **Deferred remote deletion via tombstones.** A remote file is never hard-
   deleted on delete; it is marked with a tombstone and its object is retained
   for a grace window before GC (RFC-0004). Recoverable during the window.
3. **Version retention.** Keep the last *K* previous encrypted versions of a
   changed file (default small, e.g. 3), enabling point-in-time recovery — cheap
   because manifests are immutable per generation (ADR-0006).
4. **Bulk-change circuit breaker.** If a single sync would delete or overwrite
   more than a threshold (default: **> 20 files, or > 10% of the vault**,
   whichever is smaller), **pause and require explicit confirmation**, showing the
   full list. This catches "something went very wrong" before it propagates.
   > The threshold shape in this item is **superseded by ADR-0013** (M4): an
   > absolute floor of 5 destructive operations below which the breaker never
   > fires, keeping the cap-and-fraction protection above it.

All thresholds are configurable; the *defaults* are conservative.

## Options considered

- **Rely only on tombstones + storage versioning** — good, but does not stop a
  bulk mistake from fanning out to all devices before the user notices; rejected
  as sufficient on its own.
- **Full local trash + version history + circuit breaker** — small code, directly
  addresses the motivating incident; chosen.

## Consequences

- A destructive accident is recoverable locally (`sync-trash/`), remotely
  (tombstone grace + retained versions), and is *interrupted* early (circuit
  breaker) rather than mirrored everywhere.
- Slightly more storage (retained versions + trash) — bounded by K and the grace
  window, and GC'd.
- `.obsidian/sync-trash/` MUST be in the default exclude set (it is local safety
  state, not content).
