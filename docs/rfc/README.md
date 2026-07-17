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
| [0008](./RFC-0008-Config-Sync.md) | Plugin & App Configuration Sync | Draft (post-1.0) |
| [0009](./RFC-0009-Backup.md) | Local Backup & Snapshots | Draft (post-1.0) |

> Status values reflect the **Syncrypt Specification v1.0** baseline: RFC-0001…0007
> and ADR-0001…0018 are Accepted and implemented (M1–M6). RFC-0008/0009 are
> post-1.0 drafts. The `spec-v1.0` tag is cut after field sign-off — see
> [spec-v1.0-readiness](../spec-v1.0-readiness.md).
