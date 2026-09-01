# Configuration

Syncrypt syncs what a **sync profile** tells it to. A profile is a small YAML
document with `include` / `exclude` glob rules. This gives fine control and keeps
volatile machine-specific state out of sync.

## Three categories of data

**1. Content — always synced**

```
*.md
Attachments/
Canvas/       (*.canvas)
Excalidraw/
```

**2. Configuration — selective (opt in)**

Useful to keep consistent across devices, but only chosen files:

```
.obsidian/snippets/**
.obsidian/community-plugins.json
.obsidian/plugins/dataview/**
.obsidian/plugins/templater-obsidian/**
```

**3. Excluded — never synced**

Volatile or device-specific; syncing these causes churn and conflicts:

```
.obsidian/cache/**
.obsidian/workspace.json
.obsidian/workspaces.json
.obsidian/app.json          # if it holds device-specific settings
```

## Example profile

```yaml
# syncrypt.profile.yaml
version: 1
name: default

sync:
  include:
    - "**/*.md"
    - "Attachments/**"
    - "**/*.canvas"
    - ".obsidian/snippets/**"
    - ".obsidian/community-plugins.json"
    - ".obsidian/plugins/dataview/**"
    - ".obsidian/plugins/templater-obsidian/**"

  exclude:
    - ".obsidian/cache/**"
    - ".obsidian/workspace.json"
    - ".obsidian/workspaces.json"
    - ".obsidian/app.json"
    - ".obsidian/plugins/**"      # anything not explicitly included above
    - ".obsidian/sync-trash/**"   # local Safe Sync trash — never sync
```

Rules: `exclude` wins over `include`. Paths are matched after Unicode
normalization (ADR-0007).

## Credential safety (unconditional)

Independently of your profile, Syncrypt **always hard-excludes its own settings
file** — `.obsidian/plugins/syncrypt/data.json`, which holds your S3 credentials —
from sync. Even if you add plugin data to `include`, those credentials never leave
the device through Syncrypt (ADR-0016). The passphrase is never written to disk at
all: it is entered at unlock and kept in memory only.

## Hotkeys and per-device settings

Some `.obsidian` files are best kept **per device** (e.g. `hotkeys.json` if your
Mac and PC use different shortcuts). Leave those out of `include`. When in doubt,
keep it out of sync — you can always add it later.

## Safe Mode

Safe Mode is **on by default**: when the engine is unsure, it stops and asks
rather than performing a destructive action. It also enables **Safe Sync** guard
rails (ADR-0010):

- deleted files are moved to a local `.obsidian/sync-trash/` (never synced), not
  hard-deleted;
- remote deletions are deferred via tombstones, which the manifest remembers for
  **30 days** by default and then forgets. Shorten that window and a device that
  has been offline longer than it will bring its copies of those files back;
  set it to 0 and the manifest remembers every deletion for ever;
- the last few versions of changed files are retained;
- a **bulk-change circuit breaker** pauses for your confirmation if a sync would
  delete or overwrite an unusually large number of files (default > 20 files or
  > 10% of the vault).

The breaker judges the *burst at the source*, not the size of one sync. Deleting
thirty notes one at a time over an afternoon on your phone does not stop your
desktop when it finally catches up — the deletions arrived at the pace of
someone working. Thirty deletions written at once still stop it, because that is
what an accident looks like. The window that separates the two is
**Deletion burst window** (default 300 s).

Keep Safe Mode on unless you have a specific reason not to.

## Reclaiming storage

Nothing in your bucket is deleted as a side effect of syncing. Replaced
versions past the retention depth, the ciphertext of deleted files, and entries
you forgot with **Review manifest entries** all keep costing storage until you
run **Reclaim storage** from the command palette.

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
