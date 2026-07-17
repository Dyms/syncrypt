# PROJECT — Syncrypt

This file is the single high-level entry point to the project. It describes
what Syncrypt is, how the documentation is organized, and how work is done.
For a machine-readable version aimed at AI coding agents, see
[`.ai/project.md`](./.ai/project.md).

## One paragraph

Syncrypt is a cross-platform (macOS / Windows / Android) synchronization engine
for Obsidian vaults. It stores end-to-end encrypted copies of your Markdown
files and attachments in object storage you control (S3-compatible first),
coordinated by a plain-JSON manifest. Sync reduces to two operations —
**upload** and **download** — with no hidden database, no CRDT, and no automatic
conflict resolution. The design goal is that a technical user can always explain,
inspect and repair the state by hand.

## Goals

1. Keep an Obsidian vault byte-identical across a user's own devices.
2. Never silently lose or duplicate data. Fail loudly, recover trivially.
3. Encrypt everything client-side; the storage backend learns as little as
   possible (ideally nothing but ciphertext sizes and timing).
4. Be provider-agnostic: S3 today, WebDAV / R2 / OneDrive / local folder later.
5. Be a *platform*, not just a plugin: a reusable core + SDK + provider packages,
   with the Obsidian plugin as the first consumer.
6. Be documented to a standard comparable to Kubernetes / Terraform / Rust —
   readable by humans **and** usable by AI coding agents as an implementation
   contract.

## Non-goals (v1)

- Real-time / sub-second sync.
- Multi-user collaboration on the same note at the same time.
- Automatic conflict merging (CRDT, three-way merge). Conflicts are surfaced,
  not resolved for you.
- A proprietary storage format or a hidden local database as the source of truth.
- Server-side components you must run (beyond the object storage you already have).

## Target user (v1)

A single person with one logical vault, roughly 1,000+ notes plus attachments,
who already owns S3-compatible storage, and who almost never edits the same note
on two devices simultaneously. Prioritizes durability and transparency over
immediacy.

## Documentation map

```
docs/
├── rfc/             # Normative design proposals (what & why, reviewed)
│   ├── RFC-0001-Vision.md
│   ├── RFC-0002-Product-Requirements.md
│   ├── RFC-0003-Architecture.md
│   ├── RFC-0004-Synchronization-Engine.md
│   ├── RFC-0005-Encryption-Model.md
│   ├── RFC-0006-Storage-Provider-API.md
│   └── RFC-0007-Public-API-and-SDK.md
├── adr/             # Architecture Decision Records (one decision each)
├── architecture/    # Living architecture docs + diagrams + threat model
├── security/        # Cryptography rationale, privacy policy
├── user-guide/      # End-user docs (setup, config, migration, FAQ, recovery)
├── developer-guide/ # Build, test, extend (new providers & clients)
├── sdk/             # SDK usage docs (contract in RFC-0007)
├── ui/              # UX principles & client UI specs
└── images/          # Diagram sources & screenshots
```

### RFC vs ADR — when to use which

- **RFC** — a coherent *proposal* for a subsystem or a cross-cutting concern.
  Larger, narrative, reviewed before acceptance. Numbered `RFC-000N`.
- **ADR** — a record of a *single decision*, its context, the options considered,
  and the consequences. Short, immutable once accepted. Numbered `ADR-000N`.

When an RFC is accepted, the individual sharp decisions inside it are also
captured as ADRs so they are easy to find and cite from code and PRs.

## Status & versioning

- Current phase: **implementation complete (M1–M6); pending field sign-off + `spec-v1.0` tag.**
- The specification baseline is **Syncrypt Specification v1.0**: RFC-0001…0007 and
  ADR-0001…0018 are all Accepted and implemented. The `spec-v1.0` tag is cut once
  the manual field validations (two-desktop + Android) are signed off — see
  [docs/spec-v1.0-readiness.md](./docs/spec-v1.0-readiness.md). RFC-0008/0009 are
  post-1.0 drafts.
- Architectural changes after v1.0 are made via new RFCs/ADRs, never by silent
  edits. This keeps the design auditable a year or two from now when new
  providers or features are added.

## How work is done

1. Propose or amend an RFC/ADR. Discuss. Accept.
2. Implement against the accepted specification. The spec is the contract for
   both human contributors and AI coding agents.
3. Every PR references the RFC/ADR it implements or changes.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Open decisions

Tracked in [`docs/adr/`](./docs/adr/) with status `Proposed`. The most important
still-open items:

- License choice — [ADR-0008](./docs/adr/ADR-0008-License.md).
- Manifest concurrency control on S3 — [ADR-0006](./docs/adr/ADR-0006-Manifest-Concurrency-Control.md).
- Path/metadata confidentiality vs. usability — [RFC-0005](./docs/rfc/RFC-0005-Encryption-Model.md).
