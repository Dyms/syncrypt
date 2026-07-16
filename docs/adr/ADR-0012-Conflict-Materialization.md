# ADR-0012: Conflict resolution mechanics (conflicted copies, edit-beats-delete)

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0004, RFC-0007, ADR-0010

## Context

RFC-0004 forbids merging and says a Conflict op "records both versions in the
report and (optionally) writes the remote version alongside as
`name (conflicted copy from <device> <date>).md`". A purely report-only conflict
leaves the engine in a sticky state: local ≠ base ≠ remote persists forever
unless the user makes both sides byte-identical, and two devices can never
converge — which contradicts the M1 exit criterion (fuzzed convergence with no
loss) and gives the user no artifact to reconcile from. We need concrete,
loss-free mechanics for all three conflict shapes.

## Decision

On **pull**, conflicts are materialized so that both versions survive as plain
files and the system converges:

1. **Both edited** (local B / base A / remote C): the local file stays untouched
   at its path; the remote version is written **alongside** as
   `<name> (conflicted copy from <device> <ISO date>)<ext>` (suffix `2`, `3`, …
   if taken — never overwriting anything). The base advances to remote. The next
   push uploads both files. Every device ends up with both versions.
2. **Edited locally, deleted remotely** (B / A / †): the local file is kept; the
   base records the tombstone. The next push revives the file (a new upload).
   The edit survives; the deletion is overridden and visible in the log.
3. **Deleted locally, edited remotely** (⌀ / A / C): the remote version is
   restored at the path (a creation, not an overwrite). The user can delete it
   again after review.

All three emit a `conflict` entry (ReasonCode `ConflictBothChanged`,
`ConflictSamePath`, or `ConflictEditDelete`) in the plan and report, and are
listed in `SyncReport.conflicts`. The rule in one sentence: **an edit always
beats a delete, and two edits become two files — Syncrypt never picks a winner
by discarding bytes.**

A conflicted copy is a new, ordinary file from the engine's point of view; it
syncs like any other file.

## Options considered

- **Report-only conflicts (no writes)** — strictest reading, but unresolvable in
  practice (no artifact to merge from, no convergence, permanent conflict
  state); rejected.
- **Pick-newest-mtime wins** — silent data loss, violates the prime directive;
  rejected.
- **Materialized conflicted copies + edit-beats-delete** — loss-free,
  convergent, matches the behavior RFC-0004 already sketches and what users know
  from Dropbox; chosen.

## Consequences

- Two directories always converge (M1 exit criterion is testable); conflicts
  cost one extra file instead of a wedged sync.
- Invariant "a conflict op never writes **over** a file" holds — conflicted
  copies and restores only create paths that do not exist locally.
- A deletion concurrent with an edit is deliberately the losing side; users see
  the file come back plus a conflict log line, and can delete again.
