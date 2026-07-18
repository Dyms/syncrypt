# Syncrypt

> Simple. Secure. Predictable sync for Obsidian — you own the data.

**Русская версия: [README.ru.md](./README.ru.md)**

I built Syncrypt because a sync tool once deleted and duplicated about a
thousand of my notes, and I promised myself that would never happen again.

Syncrypt keeps an [Obsidian](https://obsidian.md) vault identical across
macOS, Windows and Android using storage **you already own** — any
S3-compatible bucket (AWS, MinIO, R2, a hosting provider's S3) or a WebDAV
server (e.g. Nextcloud). Everything is **encrypted on your device before
upload**; the storage never sees a single readable byte of your notes.

It is deliberately *not* a real-time collaboration tool. It does one thing
well: move your files between your devices and your storage, safely, in a way
you can always understand — and, if everything else fails, repair by hand.

## What makes it different

- **No surprises.** Every change Syncrypt applies is written to a
  human-readable sync log with a one-sentence reason. Want to see what a sync
  *would* do first? There's a dry-run.
- **No silent data loss — by construction.** If a note changed on two devices,
  you get *both* versions side by side, never a guess. Deletions go to a local
  trash folder, never straight to oblivion. A sync that would touch an
  unusually large number of files pauses and shows you the full list before
  doing anything.
- **Your keys, your data.** Encryption keys come from your passphrase and
  never leave your device. The passphrase is never written to disk.
- **No lock-in, no server, no telemetry.** There is no Syncrypt service to
  trust or to die. With your passphrase and a ~40-line script you can decrypt
  your entire vault without Syncrypt installed —
  [see for yourself](./docs/user-guide/manual-recovery.md).
- **Boring, vetted cryptography.** Argon2id, AES-256-GCM, nothing invented
  here. [How security works](./docs/security.md).

## Get started

1. [Install via BRAT](./docs/install.md) on each device (Windows, macOS,
   Android).
2. Point it at your bucket or WebDAV folder, pick a passphrase.
3. **Sync now.** Other devices need only the same storage settings and the
   same passphrase.

Full setup guide: [docs/install.md](./docs/install.md) ·
[Getting started](./docs/user-guide/getting-started.md) ·
[Configuration](./docs/user-guide/configuration.md)

## Learn more

| | |
|---|---|
| Why I built it, goals & non-goals | [docs/about.md](./docs/about.md) |
| How security works | [docs/security.md](./docs/security.md) |
| Install & setup (BRAT) | [docs/install.md](./docs/install.md) |
| Migrating from Self-hosted LiveSync | [docs/user-guide/migration-from-livesync.md](./docs/user-guide/migration-from-livesync.md) |
| FAQ | [docs/user-guide/faq.md](./docs/user-guide/faq.md) |
| Troubleshooting | [docs/user-guide/troubleshooting.md](./docs/user-guide/troubleshooting.md) |
| Recover your data without Syncrypt | [docs/user-guide/manual-recovery.md](./docs/user-guide/manual-recovery.md) |
| Plans | [ROADMAP.md](./ROADMAP.md) |

## Status

Beta. The engine, encryption, and both storage providers are covered by an
extensive automated test suite (property-based tests assert *no data loss* and
*no silent overwrite* over randomized sync histories, against real storage
backends). I use it on my own vault daily. Beta means: keep a backup — which
is good advice with any sync tool, including this one.

## Contributing

Bug reports with reproduction steps are gold. See
[CONTRIBUTING.md](./CONTRIBUTING.md) — and please report security issues
privately per [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).

*Syncrypt is an independent open-source project, not affiliated with Obsidian.*
