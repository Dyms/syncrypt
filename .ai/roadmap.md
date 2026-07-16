# AI Context: Roadmap (condensed)

Full: `ROADMAP.md`. Milestones are dependency-ordered; durability before convenience.

- **M0 Spec** (current) — RFC-0001..0007, ADR-0001..0010 → tag spec-v1.0.
- **M1 Core** — pure engine + filesystem provider, no crypto. Planner fully tested.
- **M2 Encryption** — Argon2id + AES-256-GCM, encrypted manifest (RFC-0005).
- **M3 S3 provider** — universal subset + optional conditional-write fast path.
- **M4 Obsidian desktop** — vault adapter, triggers, Safe Sync UI, sync log.
- **M5 Android** — mobile constraints; resource-aware while-active sync.
- **M6 Migration + 2nd provider** — LiveSync migration; prove abstraction (WebDAV/R2/filesystem).

Post-1.0: more providers (R2, Backblaze, WebDAV, Dropbox, Google Drive, OneDrive,
MinIO, filesystem), more clients (Logseq, VS Code, Foam, Zettlr, CLI, Docker).
