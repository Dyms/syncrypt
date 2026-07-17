# ADR-0017: File write atomicity in the vault adapter

- **Status:** Proposed
- **Date:** 2026-07-16
- **Related:** RFC-0007 (VaultPort.write), RFC-0004, ADR-0010
- **Target:** revisit before v1.0. M4 shipped a direct write (documented below).

## Context

`RFC-0007` specifies `VaultPort.write` as "create/overwrite **atomically**
(temp + rename where possible)". The M4 Obsidian adapter instead does a **direct
`writeBinary`** to the target path. Rationale given: a temp-file + `remove`+`rename`
sequence briefly makes the target absent, and Obsidian's own file watcher (used to
trigger while-active sync) could misread that window as a *delete*, risking a
spurious deletion being planned.

The trade-off: a direct write is **not crash-safe** — if the process dies mid-write
(power loss, kill), the note can be left truncated. That conflicts with the project's
durability-first prime directive ("never lose data").

## Decision (proposed)

Prefer a **crash-safe write that avoids the absent-window**:

1. Write to a temp path with a reserved suffix (e.g. `<name>.syncrypt-tmp`) that is
   (a) in the hard-exclude set and (b) ignored by the scanner — so no watcher/scan
   ever treats it as vault content.
2. **Atomically replace** the target via rename-over (POSIX `rename`, Windows
   `ReplaceFile`/`MoveFileEx`). Rename-over never removes the target first, so there
   is **no absent window** for the watcher to misread — this beats both the M4
   direct write (crash-unsafe) and a naive remove+rename (absent window).
3. Serialize writes under the engine apply-lock so scans never observe intermediates.

Feasibility caveat: this depends on Obsidian's `DataAdapter` exposing an atomic
rename-over. If it does not (or on mobile it behaves differently), fall back to the
direct write and document the residual crash-truncation risk. Hence **Proposed** —
validate the adapter capability, then accept or record the fallback.

## Options considered

- **Direct writeBinary (M4)** — simplest, no window; not crash-safe.
- **Temp + remove + rename** — crash-safe target, but an absent window the watcher
  can misread as a delete; rejected.
- **Temp (excluded suffix) + atomic rename-over (chosen shape)** — crash-safe AND no
  absent window; best if the adapter supports it.

## Consequences

- Closes a data-durability gap consistent with the prime directive.
- Requires verifying `DataAdapter` rename-over semantics on desktop and (later) mobile.
- Until adopted, `RFC-0007 VaultPort.write` is annotated to match the shipped M4
  behavior and reference this ADR (no silent spec/impl divergence).
