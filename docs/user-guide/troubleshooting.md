# Troubleshooting

**"Sync stopped. Please pull first."**
Another device published a newer manifest since your last pull. Run a **pull**
(or Sync now), then push. This is the safety mechanism, not an error.

**A "conflicted copy" file appeared.**
You (or another device) edited the same note on both sides. Syncrypt kept both
versions instead of guessing. Open both, merge what you want into the canonical
file, delete the conflicted copy, then sync.

**Decryption failed / "authentication tag mismatch".**
Either the passphrase is wrong, or an object was corrupted/tampered in storage.
Syncrypt refuses to apply it (fail-closed). Check the passphrase first; if correct,
the stored object is damaged — restore it from a bucket version or backup.

**Duplicate-looking notes across macOS and Windows.**
Almost always a Unicode/case path mismatch. Syncrypt normalizes paths centrally
([ADR-0007](../adr/ADR-0007-Unicode-Path-Normalization.md)); if you see this,
report it with the two exact filenames (their byte encodings) so we can reproduce.

**Initial upload is slow.**
The first sync encrypts and uploads the whole vault. Subsequent syncs transfer
only changes. Large attachments use multipart upload.

**Nothing syncs on Android in the background.**
Expected. Android restricts background execution; sync runs on open/close/manual.

**How do I see exactly what happened?**
Read the sync log — every applied change has a one-sentence reason. For a preview
without changing anything, use **dry-run**.

**A sync wanted to delete/overwrite lots of files and paused.**
That's the **bulk-change circuit breaker** (Safe Sync). Review the list it shows.
If it's expected (e.g. you reorganized a big folder), confirm. If not, cancel —
nothing was changed — and investigate (wrong profile, wrong device, etc.).

**I lost a file after a sync deleted it.**
Check `.obsidian/sync-trash/` on the device where it disappeared — Safe Sync keeps
a local copy before deleting. Retained previous versions and the remote tombstone
grace window are additional recovery paths.

**"Unauthorized" from storage although the credentials are correct.**
SigV4 signing is clock-sensitive: a device clock skewed by more than a few
minutes makes every request fail authentication. Fix the device's date/time
(enable automatic time), then retry. If the error mentions
`SignatureDoesNotMatch`, also re-check the secret key for stray whitespace.

**My phone refuses to unlock the vault ("above this device's memory budget").**
The vault was created with the **desktop-only** KDF profile (128 MiB Argon2id),
which mobile devices refuse rather than crash
([ADR-0018](../adr/ADR-0018-Cross-Device-KDF-Params.md)). Unlock on a desktop,
or recreate the vault with the default cross-device profile (same passphrase;
the data re-uploads on the next sync).

**Status bar says "waiting for Wi-Fi".**
You are on cellular and **Wi-Fi only** is enabled (the default on mobile).
Your edits are safe locally and will sync on Wi-Fi; **Sync now** always works
regardless.

**A warning about LiveSync / another sync plugin appeared at unlock.**
The migration preflight found a second sync system pointed at this vault.
Syncrypt never touches other plugins — disable/remove the other system
yourself; see [the migration guide](./migration-from-livesync.md).

**Sync fails immediately inside Obsidian but works from a script.**
Make sure you run the current plugin build: storage requests must go through
Obsidian's native transport (webview `fetch` is blocked by CORS on S3/MinIO
and most WebDAV servers). Current builds do this automatically.
