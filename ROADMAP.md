# Roadmap

What Syncrypt can do today, and where it's heading. No dates — things ship
when they're safe.

## Done

- **The sync engine**: files are the truth; upload/download coordinated by a
  small encrypted manifest; conflicts kept as two versions, never merged
  silently; deletions via local trash; bulk changes require confirmation.
  Property-based tests assert *no data loss* and *no silent overwrite* over
  randomized sync histories.
- **End-to-end encryption**: Argon2id + AES-256-GCM, keys only in memory,
  documented format with tested recovery scripts —
  [how security works](./docs/security.md).
- **Storage backends**: any S3-compatible service and WebDAV — both pass the
  same conformance test suite against real servers.
- **Obsidian plugin**: desktop (Windows/macOS) and Android, with a readable
  sync log, dry-run, Safe-Sync confirmations, migration warnings, and
  battery/data-friendly mobile defaults.

## Now (beta)

- Field-testing across real devices and real storage providers.
- BRAT-installable beta releases with a proper release pipeline.
- Polishing rough edges that only daily use finds — the FAQ and
  troubleshooting pages grow from real reports.

## Next

- Community-store submission once the beta has soaked.
- Point-in-time recovery UI (the storage format already retains history).
- Optional sync for chosen Obsidian settings (with safety rails for secrets
  and device-specific files).
- Scheduled local backups — sync is not a backup, so let's make backups easy
  too.

## Someday, maybe

- More storage providers (Dropbox, Google Drive, OneDrive, local folder) —
  the provider interface is designed for this.
- More editors than Obsidian, and a headless CLI; the engine doesn't care
  who's driving it.
- Hardware-key support; optional metadata padding; compression.

Have a need that isn't listed? Open an issue — real use cases steer this
list.
