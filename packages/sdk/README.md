# @syncrypt/sdk

Public API that wires a concrete provider + vault adapter + a passphrase into a
ready-to-use `SyncEngine` (`push`, `pull`, `sync`, `dryRun`, `confirmAndApply`,
`status`). Consumed by clients such as the Obsidian plugin (or a future CLI).

```ts
import { openSyncEngine } from "@syncrypt/sdk";
import { S3Storage } from "@syncrypt/provider-s3";

const storage = await S3Storage.create({ endpoint, bucket, accessKeyId, secretAccessKey });
const engine = await openSyncEngine({
  storage,
  vault,               // the client's VaultPort implementation
  passphrase,          // derives the key ring; creates keyfile-params on first device
  deviceId,
  storagePrefix: "vaults/main",
});
const report = await engine.sync();
```

Contains no logic of its own and **no Node-only APIs** — safe for desktop,
browser, and mobile clients.

Spec: [RFC-0003](../../docs/rfc/RFC-0003-Architecture.md),
[RFC-0007 §7](../../docs/rfc/RFC-0007-Public-API-and-SDK.md).
Status: **implemented (M3)**.
