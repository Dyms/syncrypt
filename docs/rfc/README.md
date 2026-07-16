# RFCs — Syncrypt

An **RFC** (Request for Comments) is a reviewed, normative proposal describing a
subsystem or a cross-cutting concern: *what* it does and *why*, in enough detail
to implement. RFCs are narrative and may be long. Sharp, isolated decisions are
additionally recorded as [ADRs](../adr/).

## Lifecycle

```
Draft → Proposed → Accepted → (Superseded | Deprecated)
```

- **Draft** — being written, not ready for review.
- **Proposed** — under review.
- **Accepted** — ratified; it is now part of the contract. Implementation may proceed.
- **Superseded** — replaced by a later RFC (linked in the header).

Accepted RFCs are not edited in place for substantive changes; a new RFC
supersedes them. Typos and clarifications are fine.

## Index

| # | Title | Status |
|---|-------|--------|
| [0000](./RFC-0000-Template.md) | Template | — |
| [0001](./RFC-0001-Vision.md) | Vision | Accepted |
| [0002](./RFC-0002-Product-Requirements.md) | Product Requirements | Accepted |
| [0003](./RFC-0003-Architecture.md) | Architecture | Accepted |
| [0004](./RFC-0004-Synchronization-Engine.md) | Synchronization Engine | Accepted |
| [0005](./RFC-0005-Encryption-Model.md) | Encryption Model | Accepted |
| [0006](./RFC-0006-Storage-Provider-API.md) | Storage Provider API | Accepted |
| [0007](./RFC-0007-Public-API-and-SDK.md) | Public API & SDK Contract | Accepted |

> Status values here reflect the intended baseline (Syncrypt Specification v0.1).
> The author ratifies by moving the linked ADRs from `Proposed` to `Accepted`.
