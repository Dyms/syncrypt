# Troubleshooting

**"Sync stopped. Pull first — someone else published a newer version."**
Another device published a newer manifest since your last pull. Run a **pull**
(or Sync now), then push. This is the safety mechanism, not an error.

**"Sync refused — the storage holds an older state than this device."**
Something removed manifests from your storage: a restore from an older backup,
a cleanup, a lifecycle rule, or somebody with write access to the bucket.
Applying it would quietly put older copies of your files back, so Syncrypt
stops instead and names the two generations that disagree. Nothing was changed.

If you restored the storage on purpose, run the command **"Accept the storage
as it is"** and sync again — the next sync compares both sides from scratch and
keeps both versions of anything that differs as a conflicted copy, deleting
nothing. If you did *not*, do not accept it: check who can write to that bucket
first. A device that has never synced this vault cannot detect this at all,
which is one more reason to keep bucket versioning on.

**A "conflicted copy" file appeared.**
You (or another device) edited the same note on both sides. Syncrypt kept both
versions instead of guessing. Open both, merge what you want into the canonical
file, delete the conflicted copy, then sync.

**Decryption failed / "authentication tag mismatch".**
Either the passphrase is wrong, or an object was corrupted/tampered in storage.
Syncrypt refuses to apply it (fail-closed). Check the passphrase first; if correct,
the stored object is damaged — restore it from a bucket version or backup.

**Duplicate-looking notes across macOS and Windows.**
Almost always a Unicode/case path mismatch. Syncrypt normalizes paths
centrally; if you see this,
report it with the two exact filenames (their byte encodings) so we can reproduce.

**Initial upload is slow.**
The first sync encrypts and uploads the whole vault. Subsequent syncs transfer
only changes. On S3, large attachments use multipart upload; over WebDAV every
file is one request, so very large files (above ~2 GiB) are advised against.

**Nothing syncs on Android in the background.**
Expected. Android restricts background execution. Syncing happens while
Obsidian is open and in use: after edits (debounced), on the periodic pull, and
on **Sync now**. After every restart of Obsidian you must **Unlock** with your
passphrase before anything syncs.

**How do I see exactly what happened?**
Open the log with **Show sync log** — every applied change has a one-sentence
reason. The log is kept in memory (the last 500 entries) and is gone when
Obsidian restarts, so copy it before closing Obsidian if you want to report a
problem. A sync that would change many files shows you its plan and waits for
confirmation before touching anything.

**A sync wanted to delete/overwrite lots of files and paused.**
That's the **bulk-change circuit breaker** (Safe Sync). Review the list it shows.
If it's expected (e.g. you reorganized a big folder), confirm. If not, cancel —
nothing was changed — and investigate (wrong profile, wrong device, etc.).

**I lost a file after a sync deleted it.**
Check `sync-trash/` inside your Obsidian config folder (`.obsidian/sync-trash/`
unless you renamed the config folder) on the device where it disappeared — Safe
Sync keeps a local copy before deleting, and nothing ever empties it. Retained previous versions and the remote tombstone
grace window are additional recovery paths.

**"Unauthorized" from storage although the credentials are correct.**
On S3, SigV4 signing is clock-sensitive: a device clock skewed by more than a few
minutes makes every request fail authentication. Fix the device's date/time
(enable automatic time), then retry. If the error mentions
`SignatureDoesNotMatch`, also re-check the secret key for stray whitespace.
Over WebDAV, "Unauthorized" means the username or password is wrong, or the
account cannot write to that folder.

**My phone refuses to unlock the vault ("needs more memory than this device can safely use").**
The vault was created with the **desktop-only** KDF profile (128 MiB Argon2id),
which mobile devices refuse rather than crash. Your passphrase was not checked and
nothing is wrong with it. Unlock on a desktop, or recreate the vault with the
cross-device profile. Recreating means starting from an empty storage prefix: the
storage will not create new key parameters over an existing vault. Clear the prefix
yourself (after you are sure every device has everything), create the vault again
with the same passphrase, and re-join the other devices through a new ticket.

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

**A notice says "Two devices published generation N at the same moment" (fork-lost).**
Two devices pushed at once and this one did not win. Nothing is overwritten:
files that differ come back as conflicted copies with both versions, and nothing
you deleted around then stays deleted. Merge the conflicted copies and sync.

**A notice says "This device's last sync … is not part of the history the storage now holds" (base-off-line).**
The storage went back in time or the devices raced, so this device cannot trust
its record of what it last synced. It plans from no record: every difference is
kept as a conflicted copy, and deletions made around then may come back. Nothing
is overwritten. Sync every device afterwards, and be careful with **Reclaim
storage** until they have.

**"Local sync state unreadable — reconciling from scratch".**
The cache of what this device last synced was damaged. It is discarded and the
next sync compares both sides from scratch: slower, safe, and anything that
differs is kept as a conflicted copy. Your notes are untouched.

**A file will not download and the log says the storage cannot find its object.**
Something deleted ciphertext a manifest still points at — most often a bucket
lifecycle rule. Restore the object from a bucket version. See
[Bucket lifecycle rules](./configuration.md#bucket-lifecycle-rules).
