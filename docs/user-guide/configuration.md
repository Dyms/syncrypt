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
normalization ([ADR-0007](../adr/ADR-0007-Unicode-Path-Normalization.md)).

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
- remote deletions are deferred via tombstones with a grace window;
- the last few versions of changed files are retained;
- a **bulk-change circuit breaker** pauses for your confirmation if a sync would
  delete or overwrite an unusually large number of files (default > 20 files or
  > 10% of the vault).

Keep Safe Mode on unless you have a specific reason not to.
