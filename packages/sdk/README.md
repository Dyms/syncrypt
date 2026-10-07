# @syncrypt/sdk

Public API that wires a concrete provider + vault adapter + a passphrase into a
ready-to-use `SyncEngine` (`push`, `pull`, `sync`, `dryRun`, `confirmAndApply`,
`status`, and the maintenance operations). Consumed by clients such as the
Obsidian plugin (or a future CLI). Full guide: [docs/sdk](../../docs/sdk/README.md).

```ts
import { openSyncEngine } from "@syncrypt/sdk";
import { S3Storage } from "@syncrypt/provider-s3";

const storage = await S3Storage.create({
  endpoint, bucket, accessKeyId, secretAccessKey,
  vaultPrefix: "vaults/main",       // same value as storagePrefix below
});
const engine = await openSyncEngine({
  storage,
  vault,                  // the client's VaultPort implementation
  state,                  // the client's StateStorePort — see the guide; without it
                          // every run starts with no record of the last sync
  passphrase,             // derives the key ring; creates the keyfile on the first device
  deviceId,               // stable per installation, e.g. "dev-0123456789abcdef"
  storagePrefix: "vaults/main",
  createVault: false,     // an interactive client asks before creating a vault
});
const report = await engine.sync();
if (report.outcome === "needs-confirmation") {
  const plan = await engine.dryRun();   // show it to the person, then:
  // await engine.confirmAndApply(plan);
}
```

Contains no logic of its own and **no Node-only APIs** — safe for desktop,
browser, and mobile clients.

Status: **implemented**, beta (1.0.0-beta.13).
