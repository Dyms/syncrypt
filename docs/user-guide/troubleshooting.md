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
