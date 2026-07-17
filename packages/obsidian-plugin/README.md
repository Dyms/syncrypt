# @syncrypt/obsidian

The Obsidian client. Implements VaultPort via the Obsidian API, provides
settings, sync triggers (pull on open, best-effort push on quit, debounced
while-active sync, manual "Sync now"), the passphrase unlock flow,
Safe-Sync confirmations, and the human-readable sync log.

**Status: beta** — desktop and mobile builds ship from the same
Node-API-free bundle.

## Build & install (development)

```bash
npm run build -w @syncrypt/obsidian
# copy packages/obsidian-plugin/dist/* into <vault>/.obsidian/plugins/syncrypt/
# then enable "Syncrypt" in Obsidian → Settings → Community plugins
```

First run: fill in Storage settings (⚠ read the credential warning),
then run the **Unlock** command and enter your passphrase. The first device
creates `meta/keyfile-params.json`; further devices need only the passphrase.

User docs: [docs/install.md](../../docs/install.md).
