# ADR-0013: Bulk-change circuit-breaker floor for small vaults

- **Status:** Proposed
- **Date:** 2026-07-16
- **Related:** ADR-0010, RFC-0004, RFC-0007
- **Target:** M4 (client UX). Not implemented in M1 — M1 follows ADR-0010 literally.

## Context

ADR-0010 defines the bulk-change circuit breaker as tripping when a sync would
delete/overwrite more than `min(20 files, 10% of the vault)`. During M1 this was
implemented exactly as written. The `10%` term has a bad edge on **small
vaults**: with fewer than ~10 tracked files, `10%` is less than one file, so
*any single deletion* trips the breaker and demands confirmation. That is correct
per the current spec but will be annoying in the Obsidian client (M4), where
deleting one note is a routine action.

## Decision (proposed)

Introduce an absolute **floor** below which the breaker never fires, so routine
small edits are never gated, while mass changes still are:

```
requiresConfirmation =
    destructive > FLOOR
    && ( destructive >= ABS_CAP || destructive >= FRACTION * vaultSize )
```

Proposed defaults: `FLOOR = 5`, `ABS_CAP = 20`, `FRACTION = 0.10`. So:

- ≤ 5 destructive ops: never prompt (routine).
- 6…19 ops: prompt only if that is ≥ 10% of the vault.
- ≥ 20 ops: always prompt.

All three remain user-configurable (advanced users can set `FLOOR = 0` to keep
today's strict behavior).

## Options considered

- **Keep `min(20, 10%)`** — safest but noisy on small vaults; poor UX in M4.
- **Add an absolute floor (chosen shape)** — preserves protection against mass
  wipes while not nagging on 1–5 deletions.
- **Percentage only, no absolute cap** — a 10% delete on a 5,000-note vault (500
  files!) would not prompt; unsafe. Rejected.

## Consequences

- Better client UX without weakening protection against the failure mode that
  motivated the project (mass delete/duplicate).
- Slightly more parameters to document and test.
- Behavior change is **deferred to M4**; if adopted, supersede the threshold text
  in ADR-0010 and update RFC-0004 §Safe Sync and the `PlanOptions` defaults in
  RFC-0007.

## Open question

Should the floor be a fixed count (5) or itself relative (e.g. `max(5, 2%)`)? To
be decided with real client usage in M4.
