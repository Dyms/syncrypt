# Syncrypt

> Simple. Secure. Predictable sync for Obsidian — you own the data.

**Русская версия: [README.ru.md](./README.ru.md)**

I built Syncrypt because a sync tool once deleted and duplicated about a
thousand of my notes, and I promised myself that would never happen again.

Syncrypt keeps an [Obsidian](https://obsidian.md) vault identical across
macOS, Windows and Android using storage **you already own** — any
S3-compatible bucket (AWS, MinIO, R2, a hosting provider's S3). Everything is
**encrypted on your device before upload**; the storage never sees a single
readable byte of your notes.

> **WebDAV** is implemented in the engine and passes the same conformance suite
> against a real server, but the plugin does not offer it in the UI yet — the
> Obsidian client speaks S3 only for now.

It is deliberately *not* a real-time collaboration tool. It does one thing
well: move your files between your devices and your storage, safely, in a way
you can always understand — and, if everything else fails, repair by hand.

## What makes it different

- **No surprises.** Every change Syncrypt applies is written to a
  human-readable sync log with a one-sentence reason. Want to see what a sync
  *would* do first? There's a dry-run.
- **Conflicts are kept, not guessed.** If a note changed on two devices, you
  get *both* versions side by side. Deletions go to a local trash folder, never
  straight to oblivion. A sync that would touch an unusually large number of
  files pauses and shows you the full list before doing anything. This is the
  design, and it holds when devices sync one after another — see
  [Known limitations](#known-limitations) for the cases where it does not yet.
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

An audit before 1.0 found defects that break promises made further up this
page. Every one below is **reproduced**, not suspected, and each is being
fixed. They are listed here because "beta" in a version number is not a
warning — this is.

Data loss, in order of how likely you are to meet it:

- ~~**Two devices publishing in the same few seconds can lose one side's
  edit.**~~ Fixed after 1.0.0-beta.9. On beta.9 and earlier, let one device
  finish syncing before waking the next.
- **Notes whose names differ only in case can overwrite each other.**
  `Note.md` and `note.md` are two files on Android and Linux, one file on macOS
  and Windows. Publish both from a case-sensitive device and the second
  silently overwrites the first on a case-insensitive one.
  *Until it is fixed:* avoid names that differ only in case.
- **A folder excluded by a bare name can be deleted on your other devices.** A
  sync-profile exclude that matches a *folder* but not the files inside it
  (`Archive`, `**/temp`) makes this device treat those files as deleted and
  tombstone them everywhere. *Until it is fixed:* write `Archive/**` alongside
  `Archive`.

Security:

- ~~**Installed by hand from a release zip, your storage credentials can be
  uploaded.**~~ Fixed after 1.0.0-beta.9; if you are on beta.9 or earlier and
  installed by hand, install with BRAT, rename the folder to `syncrypt`, or
  leave Obsidian-settings sync off until you update.
- **Anyone who can delete objects in your bucket can roll your notes back.**
  Deleting the newest manifest makes clients accept the previous one and
  restore older versions of files, with no warning. This needs write access to
  your storage — it is not a remote attack — but it is more than the threat
  model claims.
- **A connection ticket never expires**, and is derived with fixed parameters
  rather than your vault's. Treat one like a password: send it, use it, delete
  it.
- **Obsidian-settings sync shares one list across your devices.** Any of them
  can add a plugin to it, and that plugin's `data.json` — which may hold API
  tokens — then travels to all of them. You are told after the fact, not asked.

Operational:

- **A storage key scoped to a prefix does not work yet.** The capability probe
  writes one temporary object at the bucket root, so a key restricted to
  `bucket/prefix/*` fails at unlock. Give it the whole bucket for now.
- **The `desktop-only` KDF profile is not safe for Android.** A phone will try
  to run Argon2id at 128 MiB inside a webview. If any of your devices is a
  phone, leave the profile on `cross-device`.
- **A corrupted local state file stops the plugin** until
  `.obsidian/plugins/syncrypt/sync-state.json` is deleted by hand. Your notes
  are untouched — that file is a cache and is rebuilt on the next sync.

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
