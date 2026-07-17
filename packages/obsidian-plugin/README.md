# @syncrypt/obsidian

The Obsidian client. Implements VaultPort via the Obsidian API, provides
settings, sync triggers (pull on open, best-effort push on quit, debounced
while-active sync, manual "Sync now"), the passphrase unlock flow (ADR-0016),
Safe-Sync confirmations, and the human-readable sync log.

**Status: desktop implemented (M4)**; mobile (M5) pending — the code avoids
Node-only APIs so the same bundle can target mobile after validation (see the
[compatibility matrix](../../docs/architecture/overview.md#compatibility-matrix)).

## Build & install (development)

```bash
npm run build -w @syncrypt/obsidian
# copy packages/obsidian-plugin/dist/* into <vault>/.obsidian/plugins/syncrypt/
# then enable "Syncrypt" in Obsidian → Settings → Community plugins
```

First run: fill in Storage settings (⚠ read the credential warning — ADR-0016),
then run the **Unlock** command and enter your passphrase. The first device
creates `meta/keyfile-params.json`; further devices need only the passphrase.

UI reference: [docs/ui](../../docs/ui/README.md).
