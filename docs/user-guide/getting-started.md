# Getting Started

## What you need

- Obsidian on each device (macOS / Windows / Android).
- Storage you control: an S3-compatible bucket **or** a WebDAV folder — see
  [install & setup](../install.md).
- A strong **passphrase** you will not forget. **If you lose it, your data is
  unrecoverable — by design.**

## First device

1. [Install Syncrypt via BRAT](../install.md) and open its settings.
2. Enter your storage details (endpoint, bucket/folder, prefix, credentials).
3. Run **Syncrypt: Unlock** and set your **passphrase**. Keys are derived
   locally and never leave the device; only non-secret parameters are uploaded
   so your other devices can derive the same keys from the passphrase.
4. Optionally adjust the **sync profile** (what to sync) — see
   [configuration](./configuration.md). The default covers all notes and
   attachments.
5. Run **Sync now**. This performs the initial encrypted upload.

## Additional devices

The quick way: on the configured device run **Share connection** (it makes an
encrypted "ticket"); on the new device run **Add this device from a ticket**,
paste it, enter the same passphrase — connected. Delete the transferred
ticket afterwards. Details in [install & setup](../install.md).

Manual way: install the plugin, enter the **same** storage details, unlock
with the **same** passphrase, **Sync now**.

That's it. From then on, sync happens automatically a little after you stop
editing, on app start, best-effort on close/background — and whenever you run
**Sync now**. The status bar tells you the truth at a glance: `synced ✓` only
when everything really is uploaded and current; otherwise `pending` with the
reason in the tooltip.

## Reading the sync log

Every action is explained in one line, e.g.:

```
Projects/ATM.md          remote version is newer        → downloaded
Daily/2026-07-16.md      local hash differs from base   → uploaded
Old/Deprecated.md        marked as deleted in manifest  → removed locally (to trash)
Ideas.md                 changed on both sides          → CONFLICT (see conflicted copy)
```

Open it with **Syncrypt: Show sync log**. If a sync would delete or overwrite
many files at once, Syncrypt pauses and shows the full list first — read it
before confirming.

## Where next

[Configuration](./configuration.md) · [FAQ](./faq.md) ·
[Troubleshooting](./troubleshooting.md) ·
[Recover without Syncrypt](./manual-recovery.md)
