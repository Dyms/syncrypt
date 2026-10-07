# Syncrypt

> Simple. Secure. Predictable sync for Obsidian — you own the data.

**Русская версия: [README.ru.md](./README.ru.md)**

I built Syncrypt because a sync tool once deleted and duplicated about a
thousand of my notes, and I promised myself that would never happen again.

Syncrypt keeps an [Obsidian](https://obsidian.md) vault identical across
macOS, Windows and Android using storage **you already own** — any
S3-compatible bucket (AWS, MinIO, R2, a hosting provider's S3). **WebDAV**
(Nextcloud, ownCloud, Apache mod_dav) is available as an *experimental* option. Everything is **encrypted on your
device before upload**; the storage never sees a single readable byte of your
notes.

It is deliberately *not* a real-time collaboration tool. It does one thing
well: move your files between your devices and your storage, safely, in a way
you can always understand — and, if everything else fails, repair by hand.

## What makes it different

- **No surprises.** Every change Syncrypt applies is written to a
  human-readable sync log with a one-sentence reason. A sync that would touch an
  unusually large number of files shows you the plan and waits for you.
- **Conflicts are kept, not guessed.** If a note changed on two devices, you
  get *both* versions side by side. Deletions go to a local trash folder, never
  straight to oblivion. A sync that would touch an unusually large number of
  files pauses and shows you the full list before doing anything. This is the
  design, and it holds when devices sync one after another — see
  [Known limitations](#known-limitations) for the cases where it does not yet.
- **Your keys, your data.** Encryption keys come from your passphrase and
  never leave your device. The passphrase is never written to disk.
- **No lock-in, no server, no telemetry.** There is no Syncrypt service to
  trust or to die. With your passphrase and a short script you can decrypt
  your entire vault without Syncrypt installed —
  [see for yourself](./docs/user-guide/manual-recovery.md).
- **Boring, vetted cryptography.** Argon2id, AES-256-GCM, nothing invented
  here. [How security works](./docs/security.md).

## Get started

1. [Install via BRAT](./docs/install.md) on each device (Windows, macOS,
   Android).
2. Point it at your bucket, pick a passphrase.
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

## Known limitations

Audits before 1.0 found defects that broke promises made further up this page.
The data-loss ones are fixed as of 1.0.0-beta.13 and each has a regression test;
the full list is in the [changelog](./CHANGELOG.md). What is left is below.

Fixed, kept here so you know what an older build does:

- ~~Two devices publishing in the same few seconds could lose one side's edit.~~
  Fixed after beta.9. On beta.9 and earlier, let one device finish syncing before
  waking the next.
- ~~Notes whose names differ only in case could overwrite each other.~~ Fixed in
  beta.13: both are kept, the second as a conflicted copy. On beta.12 and
  earlier, avoid names that differ only in case.
- ~~A folder excluded by a bare name could be deleted on your other devices.~~
  Fixed after beta.9.
- ~~Installed by hand from a release zip, your storage credentials could be
  uploaded.~~ Fixed after beta.9. On beta.9 and earlier, install with BRAT or
  keep Obsidian settings sync off.
- ~~Anyone who could delete objects in your bucket could roll your notes back.~~
  Fixed after beta.9: a device that has already synced refuses a storage holding
  an older state, and "Accept the storage as it is" releases it after a
  deliberate restore. A device that has *never* synced the vault has nothing to
  compare against — keep bucket versioning on.
- ~~A storage key scoped to a prefix did not work.~~ Fixed in beta.13: Syncrypt
  needs List, Get, Put and Delete under the vault's prefix, nothing else.

Still true:

- **A connection ticket never expires**, and is derived with fixed parameters
  rather than your vault's. Treat one like a password: send it, use it, delete
  it. The plugin tells you how old a ticket is when you use it.
- **Obsidian-settings sync shares one list across your devices.** Any of them
  can add a plugin to it, and that plugin's `data.json` — which may hold API
  tokens — then travels to all of them. You are told after the fact, not asked.
- **A vault created with the `desktop-only` KDF profile cannot be joined from a
  phone.** The phone refuses it with a clear message instead of trying 128 MiB
  Argon2id in a webview. If any of your devices is a phone, leave the profile on
  `cross-device`.
- **The sync log is kept in memory**, the last 500 entries, and is empty after
  Obsidian restarts. Copy it before you close Obsidian if you want to report a
  problem.
- **A device that has been offline for 256 or more sync generations after the
  storage was rolled back or forked** can no longer prove where its last sync sits
  in the storage's history, and falls back to the check used before beta.13.
  That check can, after a fork, trust a base it should not. It needs a
  rolled-back or forked storage and a device left unsynced that long; sync every
  device after any restore of the bucket.
- **Do not put expiration or archive lifecycle rules on the bucket**; see
  [Configuration](./docs/user-guide/configuration.md#bucket-lifecycle-rules).

## Status

Beta, and the list above is what beta means here. The engine, encryption and
both storage providers are covered by an extensive automated test suite,
including property-based tests over randomized sync histories against real
storage backends — which is why the defects above were found by reading the
code against its own specification rather than by those tests. I use Syncrypt
on my own vault daily. Keep a backup: good advice with any sync tool, and
honest advice about this one today.

## Contributing

Bug reports with reproduction steps are gold. See
[CONTRIBUTING.md](./CONTRIBUTING.md) — and please report security issues
privately per [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).

*Syncrypt is an independent open-source project, not affiliated with Obsidian.*
