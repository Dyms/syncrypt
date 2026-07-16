# ADR-0007: Central Unicode/case path normalization

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0004

## Context

macOS (HFS+/APFS) tends to store filenames as Unicode **NFD**; Windows and most
Linux/Android use **NFC**. Case sensitivity also differs (macOS/Windows often
case-insensitive; Android/Linux case-sensitive). Treating "resumé.md" (NFD) and
"resumé.md" (NFC) as different paths is exactly the kind of mismatch that
produces phantom duplicates — a failure mode the project exists to avoid.

## Decision

Normalize every path to a **canonical form (NFC)** at the boundary before it enters
the manifest or diff. Store canonical paths in the manifest. Detect case-only
collisions and treat them as **conflicts**, never as silent overwrites or dupes.
Path normalization lives in one place in `core`.

## Consequences

- Cross-platform paths compare correctly; no NFD/NFC duplication.
- The vault adapter must map canonical ↔ platform-native paths on read/write.
- Case-insensitive-filesystem edge cases are surfaced explicitly.
