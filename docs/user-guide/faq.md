# FAQ

**Is this real-time like Obsidian Sync or LiveSync?**
No, by design. Sync happens on open/close/manual. If you almost never edit the
same note on two devices at once, you won't notice — and you gain a simpler,
safer, inspectable system.

**What if I edit the same note on two devices?**
You get a **conflict**, not a silent merge or overwrite. Syncrypt keeps both
versions and lets you reconcile by hand.

**Can the storage provider read my notes?**
No. Everything is encrypted on your device before upload (AES-256-GCM, key from
your passphrase via Argon2id). The provider sees ciphertext. It can still see
object sizes/counts/timing — details in
[how security works](../security.md).

**What happens if I forget my passphrase?**
Your data is unrecoverable. This is inherent to end-to-end encryption. Store the
passphrase in a password manager.

**Do I need to run a server?**
No. Only the object storage you already have. There is no Syncrypt server.

**Which storage works?**
Any S3-compatible service (AWS S3, MinIO, R2, REG.RU S3, …) and **WebDAV**
(Nextcloud, Apache mod_dav, …) — both are covered by the same test suite
against real servers. More providers (consumer clouds, local folder) can be
added without touching the engine.

**Does it work on Android?**
Yes, within Obsidian mobile limits: no background daemon; sync on open, on
going to background (best-effort), debounced while editing, and manual. Wi-Fi
only is the default on mobile. Keep the default cross-device encryption
profile so phones can join the vault.

**Why does auto-sync sometimes wait?**
Resource-aware guards: it waits for edits to settle, keeps a minimum interval
between runs, and (on mobile) skips cellular. An idle check costs a single
LIST + one small GET — a few KB. **Sync now** bypasses all guards.

**Is there telemetry?**
None. Ever. See the [privacy policy](../security/privacy-policy.md).

**What stops a repeat of the mass delete/duplicate incident?**
Safe Sync (on by default): local `.obsidian/sync-trash/` before deletes, deferred
remote deletes (tombstones + grace), retained file versions, and a bulk-change
circuit breaker that pauses when a sync would touch an unusually large number of
files.

**Can I recover files without Syncrypt?**
Yes — with your passphrase and the documented format you can decrypt the manifest
and any object with a short script — see [manual recovery](./manual-recovery.md).
