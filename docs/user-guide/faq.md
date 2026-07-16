# FAQ

**Is this real-time like Obsidian Sync or LiveSync?**
No, by design. Sync happens on open/close/manual. If you almost never edit the
same note on two devices at once, you won't notice — and you gain a simpler,
safer, inspectable system. See [ADR-0001](../adr/ADR-0001-No-CRDT-No-Realtime.md).

**What if I edit the same note on two devices?**
You get a **conflict**, not a silent merge or overwrite. Syncrypt keeps both
versions and lets you reconcile by hand. See
[sync-flow](../architecture/sync-flow.md).

**Can the storage provider read my notes?**
No. Everything is encrypted on your device before upload (AES-256-GCM, key from
your passphrase via Argon2id). The provider sees ciphertext. It can still see
object sizes/counts/timing — see the
[threat model](../architecture/threat-model.md).

**What happens if I forget my passphrase?**
Your data is unrecoverable. This is inherent to end-to-end encryption. Store the
passphrase in a password manager.

**Do I need to run a server?**
No. Only the object storage you already have. There is no Syncrypt server.

**Which storage works?**
S3-compatible first (e.g. REG.RU S3, AWS S3). WebDAV, R2, OneDrive, and a local
folder are planned via the provider abstraction
([RFC-0006](../rfc/RFC-0006-Storage-Provider-API.md)).

**Does it work on Android?**
That's a v1 target, within Obsidian mobile limits (no background daemon; sync on
open/close/manual). See the compatibility matrix in
[overview](../architecture/overview.md#compatibility-matrix).

**Is there telemetry?**
None. Ever. See the [privacy policy](../security/privacy-policy.md).

**What stops a repeat of the mass delete/duplicate incident?**
Safe Sync (on by default): local `.obsidian/sync-trash/` before deletes, deferred
remote deletes (tombstones + grace), retained file versions, and a bulk-change
circuit breaker that pauses when a sync would touch an unusually large number of
files. See [ADR-0010](../adr/ADR-0010-Data-Safety-Guard-Rails.md).

**Can I recover files without Syncrypt?**
Yes — with your passphrase and the documented format you can decrypt the manifest
and any object with a short script — see [manual recovery](./manual-recovery.md).
