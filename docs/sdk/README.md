# SDK guide

`@syncrypt/sdk` is the programmatic way to drive Syncrypt outside Obsidian
(scripts, a CLI, another editor). The quick start is in the
[package README](../../packages/sdk/README.md). This page is what you need to know
so that your client is as safe as the plugin.

The SDK re-exports everything from `@syncrypt/core` (ports, types, the engine,
errors) and adds `openSyncEngine`, the crypto helpers (`SyncryptCrypto`,
`openVaultCrypto`, `keyfilePathFor`, `vaultHasKeyfile`, `legacyPassphraseForms`),
and the KDF presets `CROSS_DEVICE_KDF_PRESET` and `DESKTOP_KDF_PRESET` with
`MOBILE_MEMORY_BUDGET_KIB`. There is one default preset for new vaults:
cross-device. Connection-ticket functions live in `@syncrypt/crypto`, not here.

## What you implement

- **`VaultPort`** — reading and writing the user's files.
  `read` must reject with `VaultFileNotFound` **only** when the file is certainly
  absent. Any other failure must be a different error: the engine treats "not
  found" as a deletion and tombstones the file for every device. `write` may return
  the stat of exactly the bytes it wrote, which lets the engine tell a download
  from a later edit. `syncable(path)` (optional) says whether a path belongs to the
  vault's profile.
- **`StateStorePort`** — `load()` / `save()` of one opaque blob. It is a cache of
  *what this device last synced* (the base). Without a persistent one, every run
  starts with no base: differences become conflicted copies and deletions do not
  propagate. Give each storage location and vault its own blob; the engine records
  the vault's identity with it and refuses a base from another vault.
- A `StoragePort`: use a provider (`@syncrypt/provider-s3`,
  `@syncrypt/provider-webdav`, `@syncrypt/provider-filesystem`) or implement one.

## `openSyncEngine` options

| Option | Notes |
|---|---|
| `storage`, `vault`, `passphrase`, `deviceId` | Required. |
| `state` | See above. Strongly recommended. |
| `storagePrefix` | Key prefix of this vault. For S3 pass the same value as `vaultPrefix` to `S3Storage.create`, so the capability probe is written inside the vault's prefix and a key scoped to the prefix works. |
| `createVault` | Default `true`: an empty location silently becomes a **new vault**. An interactive client must pass `false` and ask the person; it then gets `VaultAbsent` for an empty location. |
| `affordability` | Mobile clients must pass `{ maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB }` (64 MiB). A vault created as desktop-only (128 MiB) is then refused cleanly instead of exhausting the device. |
| `kdfDefaults` | Preset for the first device of a new vault. Default: cross-device. |
| `safeSync` | `SafeSyncOptions`: confirmation thresholds, `deletionBurstWindow`, `versionsToKeep`, `tombstoneGraceSeconds`, `reclaimGraceSeconds`, `generationsToKeep`. |
| `clientVersion` | Recorded in manifests; mismatched clients are reported as notices. |
| `clock`, `log` | Injectable for tests and for showing the log. |

`deviceId` must be stable for the **installation** (not for the folder: a copied
vault folder must not copy it) and match `^(?!\.+$)[A-Za-z0-9_.-]{1,64}$`. Two
devices with one ID can publish the same manifest key and lose an edit.

The passphrase goes in as UTF-8 NFC; `openSyncEngine` also tries the legacy byte
forms for vaults created before that rule and keeps the one the vault accepts.

## Running a sync

`sync()`, `pull()` and `push()` return a `SyncReport` whose `outcome` you must
handle; most of them mean *nothing was applied*:

| `outcome` | Meaning |
|---|---|
| `applied`, `no-op` | Done. |
| `needs-confirmation` | The bulk-change breaker fired. Show `dryRun()`'s plan; apply with `confirmAndApply(plan)`. A plan that went stale is refused, not applied. |
| `pull-first` | Another device published newer. Pull, then push. |
| `conflicts` | Applied, with conflicted copies in `report.conflicts`. |
| `rolled-back` | The storage holds an older generation than this device had. Nothing is applied until the person decides (`acceptRolledBack()` after they confirm). |
| `aborted` | The `AbortSignal` you passed fired. Every operation takes one. |

Other operations: `status()`, `verifyAccess()`, `forgetBase()`, `acceptRolledBack()`,
`setSafeSync()`, `listUncarried()`, `forgetPaths()`, `listFileVersions()`,
`readFileVersion()`, `previewRelease()`,
`releaseForgotten()`, `previewReclaim()`, `reclaimStorage()`, `forgetHashCache()`.
`listFileVersions(path)` lists the versions storage holds for one path (current,
then retained, newest first) and `readFileVersion(path, hash)` returns one,
decrypted and verified; both only read.
`reclaimStorage()` is the only operation that deletes from storage, in two steps
separated by a safety window; show the preview first.

## Notices your client must surface

The engine reports conditions through `LogPort` notices. These change what the
person should do next, so show them: `fork-lost`, `base-off-line`,
`base-other-vault`, `storage-rolled-back`, `vault-written-by-newer` /
`vault-written-by-older`, `paths-not-distinct`, `paths-unreadable`,
`paths-changed-during-sync`, `passphrase-legacy-form`, `deletions-paced`,
`tombstones-expired`, `state-unreadable`. The Obsidian plugin's wording for each
is in `packages/obsidian-plugin/src/i18n.ts`.

## Installing

The packages are workspace packages of this repository and are not published to
a registry yet; their `main` points at TypeScript sources. Consume them from a
checkout of this repository (`npm ci` links the workspaces).
