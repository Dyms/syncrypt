# Configuration

Everything below is in **Settings → Syncrypt**. Settings are per device and
live in the plugin's `data.json`; nothing here is stored in your vault's notes.

## What gets synced

Syncrypt syncs the contents of your vault: notes, attachments, folders. Two
fields under **What gets synced** narrow that down; leave them alone unless you
have a reason.

- **Include** — path patterns, one per line. Default: `**` (everything).
- **Exclude** — path patterns to skip, one per line, applied after Include.
  Default: `.*`, `.*/**`, `**/.DS_Store`.

Rules:

- `exclude` wins over `include`. Excluding a folder excludes what is inside it.
- Patterns: `**` any characters including `/`; `*` any characters except `/`;
  `?` one character except `/`. A leading `**/` (or `**/` after a `/`) matches
  zero or more folders, so `**/*.md` matches `Note.md` at the vault root as well
  as `Projects/Note.md`. There is no `[a-z]` or `{a,b}` syntax.
- Paths are matched after Unicode normalization.
- **Anything whose path has a segment starting with a dot is never synced** —
  that includes `.obsidian`. This is not a pattern you can switch off in
  Include. The settings inside `.obsidian` travel only through
  [Obsidian settings sync](#obsidian-settings-sync).
- **Count files** shows what the current patterns match without syncing.

Examples:

| Goal | Include | Exclude |
|---|---|---|
| Everything (default) | `**` | (default) |
| Notes only | `**/*.md` | (default) |
| One folder | `Projects/**` | (default) |
| Skip a folder | `**` | `Archive` or `Archive/**` |
| Skip PDFs | `**` | `**/*.pdf` |

Narrowing the profile never deletes anything: a file that stops matching is
simply left alone, locally and in storage.

## Obsidian settings sync

Off by default. When on, the settings you choose travel with your notes,
encrypted like everything else. Plugin **code** is never synced — install each
plugin on every device yourself; this carries only its settings. A restart of
Obsidian is needed on the receiving device before changed settings take effect.

Items, each its own switch: **Appearance** (`appearance.json`), **Editor and
files** (`app.json`, off by default — some values are device-specific),
**Hotkeys**, **Themes**, **CSS snippets**, **Core plugins list**, **Community
plugins list**, and per-plugin **Plugin settings** (only that plugin's
`data.json`). A plugin known to keep API keys or passwords is marked: if you
choose it, those secrets are uploaded (encrypted) and land on your other devices.

Never synced, whatever you pick (ADR-0016): Syncrypt's own settings (`data.json`
holds your storage keys), your window layout (`workspace*.json`), and the
sync-trash.

The passphrase is never written to disk at all: it is entered at unlock and
kept in memory only.

## Safe Sync

Safe Sync is always on. When the engine is unsure it stops and asks rather than
doing something destructive. Its guard rails:

- **Trash.** A file deleted by a sync goes to `<config folder>/sync-trash/`
  (local, never synced), not into oblivion. Syncrypt never empties it; clear it
  yourself when you are sure.
- **Versions to keep** (default 3): prior encrypted versions kept per changed file.
- **Forget a deletion after (days)** (default 30): how long the manifest
  remembers that a file was deleted. Shorten it and a device that has been
  offline longer than that brings its copies of those files back; 0 means never
  forget.
- **Bulk-change circuit breaker.** A sync that would delete or overwrite an
  unusually large number of files pauses for your confirmation. It fires when
  the count is above **Confirmation floor** (default 5) **and** at least
  **Always confirm at** (default 20) files **or** at least **Vault fraction**
  (default 0.1 = 10%) of the vault. Raising these weakens the breaker; a floor of
  0 makes it strict (any destructive change above 0 can prompt).
- **Deletion burst window** (default 300 s). The breaker judges the burst at the
  source, not the size of one sync: deleting thirty notes one at a time over an
  afternoon on your phone does not stop your desktop when it finally catches up.
  Thirty deletions written at once still stop it, because that is what an
  accident looks like.

When the breaker pauses a sync you see the plan, and **Sync now** applies it
only after you confirm.

Other settings in this section: **Reclaim safety window (hours)** (default 24,
minimum 1) and **Manifest generations to keep** (default 10) — see
[Reclaiming storage](#reclaiming-storage).

## Auto-sync

- **Sync while editing** (default on): a debounced sync once edits settle.
  **Sync now** always works.
- **Debounce (seconds)** (default 15): quiet time after the last edit.
- **Minimum interval (seconds)** (default 30; 120 on mobile): at most one
  auto-sync per this many seconds.
- **Pull every (seconds)** (default 900; 1800 on mobile; 0 = off): while
  Obsidian is open, look for other devices' changes even if nothing changed here.
- **Wi-Fi only** (default off; on for mobile): skip automatic syncs on cellular.

Nothing syncs until you have entered the passphrase after starting Obsidian
(**Unlock**). **Lock** forgets the keys; edits stay local and sync waits.

## Vault creation

**Vault KDF profile** matters only on the device that creates the vault.
**Cross-device** (default) can be joined from phones; **Desktop-only** (128 MiB
Argon2id) is stronger, but a phone refuses to join it. Choose it before you press
Create vault; it cannot be changed afterwards without recreating the vault.

## Device ID

Each installation has a stable **Device ID** (`dev-` and 16 hex digits) used in
manifests and in the names of conflicted copies. It belongs to the installation,
not to the vault folder: on Obsidian 1.8.7 or newer, a vault folder copied with
its plugin settings to another computer gets a new ID there, with a notice. On
older Obsidian a copied folder keeps the copied ID, which breaks sync between the
two computers — install the plugin fresh on the second one and connect it with a
connection ticket instead of copying the folder. Do not edit the ID by hand.

## Reclaiming storage

Nothing in your bucket is deleted as a side effect of syncing. Replaced
versions past the retention depth and the ciphertext of deleted files keep
costing storage until you run **Reclaim storage** from the command palette.

Entries you stop carrying on a device are a separate, two-step matter.
**Review manifest entries this device does not carry** lets you *forget* entries
that fall outside this device's profile. Forgetting touches no file, records no
deletion and keeps the stored copy, so it stays undoable. The kept copies are
freed only by **Release the copies kept for forgotten entries**, and only after
that can **Reclaim storage** delete them.

It is the one thing Syncrypt does that nothing undoes — a deleted object has no
trash, no retained version, and no other device that puts it back — so it works
in two steps. The first run records what nothing references any more and tells
you when it can go; a run after the safety window (default 24 hours) deletes it,
re-checking first that nothing has started pointing at it in the meantime. That
re-check is what makes the deletion safe against a sync running elsewhere at the
same time, so do not shorten the window to nothing.

The same command prunes old manifest generations beyond **Manifest generations
to keep** (default 10). Those generations are point-in-time history: after
pruning you can still recover from the newest generations and from each file's
retained versions, and no further back.

One storage prefix holds one vault. Two vaults sharing a prefix cannot work in
the first place, and with reclamation they would delete each other's data.

## Bucket lifecycle rules

Do not put an expiration or transition-to-archive rule on the bucket (or on
the prefix Syncrypt uses). Syncrypt decides what is garbage itself, and only
**Reclaim storage** deletes anything.

- A rule that expires objects deletes ciphertext that a manifest still points
  at. The file it belonged to can no longer be downloaded by any device, and
  nothing in the bucket says why. Expiring `manifests/` is as bad: it looks
  to every device like the storage went back in time, and they refuse to sync
  (see [Troubleshooting](troubleshooting.md)).
- Archive tiers that need a restore request (Glacier-style) make every read of
  that object fail until the restore finishes, so syncs that need it fail
  until then. Syncrypt does not special-case archive tiers; keep them off.
- Rules that only act on **non-current versions** of objects are fine, and a
  good idea if you keep bucket versioning on: they cap the cost of history
  without touching the current state.
- A rule that aborts incomplete multipart uploads is fine and recommended.

If a rule already ran and objects are gone, restore them from a bucket version
before syncing again; a sync that needs a missing object fails instead of
skipping it.
