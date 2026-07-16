# ADR-0001: No CRDT, no real-time sync

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0001, RFC-0002, RFC-0004

## Context

The target user (RFC-0002) has one vault and almost never edits the same note on
two devices at once. A prior CRDT/real-time system (Self-hosted LiveSync) caused a
partial-delete + duplication incident on ~1,000 notes. CRDT + revision trees add a
hidden database and hard-to-reason failure modes to solve a concurrency problem the
user does not have.

## Decision

Syncrypt does **not** use CRDTs, revision trees, or real-time replication, and does
**not** auto-merge. Divergent edits are surfaced as conflicts for manual resolution.

## Options considered

- **CRDT/real-time (LiveSync-style)** — great for concurrent multi-device editing;
  opaque, heavy, risky for a single user; rejected.
- **Manifest-based eventual sync** — simple, explainable, hand-repairable; chosen.

## Consequences

- Much simpler engine and failure model; sync is explainable per RFC-0001.
- No sub-second propagation and no automatic merge — accepted non-goals (RFC-0002).
- Conflicts require user action; expected to be rare.
