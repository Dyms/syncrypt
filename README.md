# Syncrypt

> Simple. Secure. Predictable file sync for Obsidian — you own the data.

**Syncrypt** is a small, explainable synchronization engine for
[Obsidian](https://obsidian.md) vaults. It keeps your notes identical across
macOS, Windows and Android using storage **you already own** (S3-compatible
object storage first; more providers later), with **client-side end-to-end
encryption**.

It is deliberately *not* a real-time collaboration tool. It does one thing well:
move your Markdown files between your own devices and your own storage, safely,
in a way you can always understand and repair by hand.

---

## Why it exists

Real-time CRDT-based sync (e.g. Self-hosted LiveSync) is powerful but solves a
*different* problem. For a single user who never edits the same note on two
devices at the same instant, a hidden database, a revision tree and automatic
conflict resolution add risk (silent duplication, data loss on corruption)
without adding value.

Syncrypt takes the opposite bet:

- The **source of truth is your Markdown files**, not a database.
- Sync is just **upload** and **download**, coordinated by a plain JSON
  `manifest`.
- There is **no magic**: every action is explainable in one sentence
  (*"remote version is newer"*, *"local hash differs from manifest"*,
  *"file marked as deleted"*).
- If something goes wrong, you can open, restore or download any file by hand.

## Principles

- **Simple. Secure. Predictable.**
- **User owns the data** — no vendor lock-in, no proprietary format, no hidden database.
- **No magic** — every synchronization step is explainable.
- **Offline first** — losing the network is a non-event.
- **Markdown first** — plain files are the contract.
- **Zero telemetry** — Syncrypt never phones home.

Prime directive: **Syncrypt should never surprise the user.**

## Status

**Pre-alpha — specification phase.** This repository currently contains the
architecture specification (RFCs, ADRs, threat model). Implementation follows
the specification. See [`ROADMAP.md`](./ROADMAP.md) and
[`docs/rfc/`](./docs/rfc/).

## Documentation

| Area | Start here |
|------|------------|
| Vision & scope | [RFC-0001 Vision](./docs/rfc/RFC-0001-Vision.md) |
| What it must do | [RFC-0002 Product Requirements](./docs/rfc/RFC-0002-Product-Requirements.md) |
| How it is built | [RFC-0003 Architecture](./docs/rfc/RFC-0003-Architecture.md) |
| Sync engine | [RFC-0004 Synchronization Engine](./docs/rfc/RFC-0004-Synchronization-Engine.md) |
| Encryption | [RFC-0005 Encryption Model](./docs/rfc/RFC-0005-Encryption-Model.md) |
| Storage backends | [RFC-0006 Storage Provider API](./docs/rfc/RFC-0006-Storage-Provider-API.md) |
| API / SDK contract | [RFC-0007 Public API & SDK](./docs/rfc/RFC-0007-Public-API-and-SDK.md) |
| Decisions log | [docs/adr/](./docs/adr/) |
| Threat model | [docs/architecture/threat-model.md](./docs/architecture/threat-model.md) |
| Using it | [docs/user-guide/getting-started.md](./docs/user-guide/getting-started.md) |
| Manual recovery | [docs/user-guide/manual-recovery.md](./docs/user-guide/manual-recovery.md) |
| Русская документация | [README.ru.md](./README.ru.md) · [docs/ru/](./docs/ru/) |
| For AI agents | [CLAUDE.md](./CLAUDE.md) · [.ai/project.md](./.ai/project.md) |

## Repository layout

```
syncrypt/
├── docs/                 # Specification: RFCs, ADRs, architecture, security, guides
├── packages/
│   ├── core/             # Platform-agnostic sync engine (manifest, diff, crypto orchestration)
│   ├── sdk/              # Public TypeScript API consumed by clients
│   ├── obsidian-plugin/  # Obsidian integration (desktop + mobile) — first client
│   └── providers/
│       ├── s3/           # S3-compatible StorageProvider (first backend)
│       ├── r2/           # Cloudflare R2 (planned)
│       ├── webdav/       # WebDAV / Nextcloud (planned)
│       └── filesystem/   # Local folder / external drive (also the test backend)
├── examples/             # Runnable examples (once the SDK exists)
├── tests/                # Cross-package & end-to-end tests
├── scripts/              # Build / release / recovery / GC scripts
├── design/               # UX sketches & brand assets
└── .ai/                  # Machine-readable project context for AI coding agents
```

## License

MIT — see [LICENSE](./LICENSE) and [ADR-0008](./docs/adr/ADR-0008-License.md).

## A note on the name

An unrelated, now-defunct Python project was also called *syncrypt*. This
project is independent; the npm scope `@syncrypt` is reserved. See
[ADR-0009](./docs/adr/ADR-0009-Naming.md) for positioning.
