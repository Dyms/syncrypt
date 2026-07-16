# ADR-0004: Markdown files are the source of truth

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0001, RFC-0002

## Context

Durability and user ownership are the top priorities. A hidden database as the
authoritative store is what made the prior incident hard to recover from.

## Decision

The **plaintext files in the vault** are authoritative. The manifest is
coordination metadata, not a competing source of truth; the local base is a cache.
Any file must be restorable by hand from storage + passphrase without Syncrypt.

## Consequences

- No proprietary format, no lock-in; aligns with "user owns the data".
- The engine must never require a note to pass through a non-file representation.
- Enables the hand-recovery guarantee (RFC-0005).
