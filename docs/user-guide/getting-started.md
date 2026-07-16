# Getting Started

> Status: the engine is not yet implemented (see [ROADMAP](../../ROADMAP.md)).
> This guide describes the intended v1 flow so the design can be validated.

## What you need

- Obsidian on each device (macOS / Windows / Android).
- An S3-compatible bucket you control (endpoint, region, access key, secret,
  bucket name, optional prefix).
- A strong **passphrase** you will not forget. **If you lose it, your data is
  unrecoverable — by design.**

## First device

1. Install the Syncrypt plugin in Obsidian and open its settings.
2. Enter your storage details (endpoint, bucket, prefix, credentials).
3. Set your **passphrase**. Syncrypt derives your encryption key locally
   (Argon2id) and uploads only the non-secret KDF parameters.
4. Choose a **sync profile** (what to sync) — see
   [configuration](./configuration.md). The default covers all notes and
   attachments and a safe subset of `.obsidian/`.
5. Run **Sync now**. This performs the initial encrypted upload and writes the
   first `manifest.json`.

## Additional devices

1. Install the plugin, enter the **same** storage details and the **same**
   passphrase.
2. Run **Sync now** → Syncrypt pulls and decrypts the vault.

That's it. From then on, sync happens on Obsidian open (pull), on close (push),
or when you run **Sync now**.

## Reading the sync log

Every action is explained in one line, e.g.:

```
Projects/ATM.md          remote version is newer        → downloaded
Daily/2026-07-16.md      local hash differs from base   → uploaded
Old/Deprecated.md        marked as deleted in manifest  → removed locally
Ideas.md                 changed on both sides          → CONFLICT (see conflicted copy)
```

If you see `Sync stopped. Please pull first.`, another device published since your
last pull — just pull, then push again.
