# ADR-0002: Manifest-based sync with two primitives

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0004, ADR-0006

## Context

We need to coordinate state across devices without a database. We need to detect
what changed, transfer only deltas, represent deletions, and detect divergence.

## Decision

Use a single **manifest** (JSON, encrypted) as the coordination point, with only
two primitive operations — **upload** and **download** — plus explicit
**tombstones** for deletion. Change detection is by **content hash** (mtime is
advisory). The manifest carries a monotonic `generation`; publication is the
atomic commit — immutable generation objects + LIST fork detection, portable to
any S3 (ADR-0006). On divergence: stop with `Please pull first`.

## Options considered

- **Timestamp/mtime-only sync** — fragile across devices and copies; rejected as
  sole signal (kept only as a hint).
- **Hidden local DB index** — reintroduces a second source of truth; rejected.
- **Manifest + content hashing** — inspectable, deterministic, hand-repairable;
  chosen.

## Consequences

- State is a file you can read and edit. Planner is a pure function → testable.
- Safe concurrent publish on any S3 via LIST + immutable manifests; conditional
  writes are an optional fast path (ADR-0006).
- Full re-hash needed if local base cache is lost (safe, slower).
