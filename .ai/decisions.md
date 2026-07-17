# AI Context: Decisions (index)

Cite these in code comments and PRs. Full text in `docs/adr/`.

- ADR-0001 No CRDT / no real-time (Accepted)
- ADR-0002 Manifest-based sync, two primitives (Accepted)
- ADR-0003 Client-side E2EE: AES-256-GCM + Argon2id (Accepted)
- ADR-0004 Markdown files are the source of truth (Accepted)
- ADR-0005 Storage provider abstraction (Accepted)
- ADR-0006 Manifest concurrency via conditional writes (Proposed — verify S3 vendor)
- ADR-0007 Central Unicode/case path normalization (Accepted)
- ADR-0008 License: MIT (Accepted)
- ADR-0009 Name "Syncrypt" + namespacing (Accepted)
- ADR-0010 Data-safety guard rails / Safe Sync: local sync-trash, deferred deletes, version retention, bulk-change circuit breaker (Accepted)
- ADR-0011 Base-manifest persistence via StateStorePort (Accepted, M1)
- ADR-0012 Conflict mechanics: conflicted copies + edit-beats-delete (Accepted, M1) — supersedes report-only sketch in RFC-0004
- ADR-0013 Bulk-change breaker floor for small vaults (Proposed, target M4)
- ADR-0014 Keyfile KDF parameter floor — reject weak Argon2id params (anti-downgrade), target M3 (Accepted)
- ADR-0015 S3 client: fetch + SigV4 (aws4fetch), not AWS SDK — portable to Obsidian mobile, tiny bundle (Accepted, M3)
- ADR-0016 Client secret storage: passphrase session-only (memory, Lock clears); S3 creds in data.json w/ UI warning; plugin data.json hard-excluded from sync (Accepted, M4)
- ADR-0017 File write atomicity — prefer temp(excluded)+atomic rename-over; M4 shipped direct write (Proposed, revisit before v1.0)
- ADR-0018 Cross-device Argon2id params: mobile-safe default (32MiB/t4), desktop-only 128MiB opt-in, fail-closed affordability ceiling (Accepted, M5)

## Post-1.0 proposals (Draft — not in v1 scope)
- RFC-0008 Config Sync (per-plugin opt-in settings sync; safety rails: secrets denylist, device-specific, conflict caveat, version skew)
- RFC-0009 Local Backup & Snapshots (plaintext vault snapshot + incremental encrypted repo mirror via filesystem provider; read-only, verified, retention)
