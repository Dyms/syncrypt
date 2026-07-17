# ADR-0017: File write atomicity in the vault adapter

- **Status:** Accepted (M6 — fallback variant with mandatory read-back verification)
- **Date:** 2026-07-16 (resolved 2026-07-17)
- **Related:** RFC-0007 (VaultPort.write), RFC-0004, ADR-0010

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

## Decision (accepted — fallback with mandatory verification)

The preferred temp+rename-over shape is **not implementable** through the
public `DataAdapter`: `rename` refuses an existing target (on mobile too), and
reaching for Node `fs` on desktop would violate the no-Node-API rule that
keeps the client mobile-portable. Therefore:

1. **Direct `writeBinary` stays**, avoiding the absent-window the watcher
   could misread as a deletion.
2. **Mandatory read-back verification** (this is a REQUIRED element of the
   fallback, not an optimization): after every write, the adapter reads the
   file back and verifies content equality with what was written
   (hash-equivalent, byte-exact — no crypto dependency in the adapter). Any
   mismatch throws `VaultWriteFailed` loudly; the engine does not advance past
   a failed write.
3. **Residual risk, documented honestly:** a hard crash exactly during the
   write syscall can leave ONE truncated local file, and the verification
   never runs. On the next scan the truncated file looks like a local edit
   (hash differs from base) and would be uploaded as such — visibly, in the
   log, with the prior version retained by Safe-Sync version history
   (ADR-0010 §3) and recoverable from storage. No SILENT loss is possible;
   a truncation is always either caught at write time or surfaced as an
   ordinary, recoverable, logged change.

Revisit if Obsidian ships an atomic rename-over/`ReplaceFile` API.

## Options considered

- **Direct writeBinary, unverified (M4)** — simplest, no window; not crash-safe
  and a completed-but-corrupted write would go unnoticed; superseded.
- **Temp + remove + rename** — crash-safe target, but an absent window the watcher
  can misread as a delete; rejected.
- **Temp (excluded suffix) + atomic rename-over** — crash-safe AND no absent
  window; NOT available through the public DataAdapter (rename refuses existing
  targets; Node fs is off-limits in the client); shelved until Obsidian exposes it.
- **Direct write + mandatory read-back verification (chosen)** — no absent
  window, corrupted-but-completed writes caught immediately, residual risk
  narrowed to a hard crash mid-syscall and made non-silent by scan+history.

## Consequences

- One extra read per downloaded file (downloads are not the hot path).
- The residual crash-truncation risk is explicit, bounded to one file, and
  never silent (log + version retention + storage copy).
- `RFC-0007 VaultPort.write`'s "atomically (temp + rename where possible)"
  reads with this ADR as the definition of "where possible" for Obsidian.
