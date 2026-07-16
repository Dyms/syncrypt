# Architecture Decision Records — Syncrypt

An **ADR** captures one architectural decision: its context, the options
considered, the choice, and the consequences. ADRs are short and, once
**Accepted**, immutable — a later ADR supersedes an earlier one rather than
editing it. See [PROJECT.md](../../PROJECT.md) for RFC vs ADR.

## Status values

`Proposed` · `Accepted` · `Superseded` · `Deprecated`

## Index

| # | Decision | Status |
|---|----------|--------|
| [0001](./ADR-0001-No-CRDT-No-Realtime.md) | No CRDT, no real-time sync | Accepted |
| [0002](./ADR-0002-Manifest-Based-Sync.md) | Manifest-based sync, two primitives | Accepted |
| [0003](./ADR-0003-Client-Side-Encryption.md) | Client-side E2EE: AES-256-GCM + Argon2id | Accepted |
| [0004](./ADR-0004-Markdown-Source-Of-Truth.md) | Markdown files are the source of truth | Accepted |
| [0005](./ADR-0005-Storage-Provider-Abstraction.md) | Storage provider abstraction | Accepted |
| [0006](./ADR-0006-Manifest-Concurrency-Control.md) | Provider-agnostic manifest concurrency | Accepted |
| [0007](./ADR-0007-Unicode-Path-Normalization.md) | Central Unicode/case path normalization | Accepted |
| [0008](./ADR-0008-License.md) | Project license — MIT | Accepted |
| [0009](./ADR-0009-Naming.md) | Name "Syncrypt" & positioning | Accepted |
| [0010](./ADR-0010-Data-Safety-Guard-Rails.md) | Data-safety guard rails ("Safe Sync") | Accepted |
| [0011](./ADR-0011-Base-State-Persistence.md) | Base-manifest persistence via StateStorePort | Accepted |
| [0012](./ADR-0012-Conflict-Materialization.md) | Conflict mechanics: conflicted copies, edit-beats-delete | Accepted |
