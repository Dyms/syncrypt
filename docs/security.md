# How security works

*Русская версия: [docs/ru/security.md](./ru/security.md)*

The short version: **everything is encrypted on your device before it leaves,
the keys come from your passphrase and never leave, and the format is
documented so you can decrypt your data without Syncrypt.** No accounts, no
servers of mine, no telemetry.

## From passphrase to keys

When you unlock a vault, your passphrase goes through **Argon2id** — a
deliberately slow, memory-hungry function designed to make password guessing
expensive even for attackers with racks of GPUs. The result is a master key,
from which separate keys are derived for file contents, for the sync manifest,
and for naming objects in storage.

- The passphrase and all keys **live only in memory**. They are never written
  to disk, never logged, never uploaded. Closing Obsidian (or the Lock
  command) forgets them.
- The only key-related thing stored in your bucket is a small file with the
  Argon2id *parameters* and a random salt — public by design, secret-free.
  It's what lets a new device derive the same keys from just your passphrase.
- Losing the passphrase means losing the data. **This is inherent to real
  end-to-end encryption** — there is no reset link because there is no one who
  could reset it. Store the passphrase in a password manager.

## What's actually in your bucket

Every note, every attachment, and the sync manifest itself are encrypted with
**AES-256-GCM** — the same authenticated encryption your bank uses — each with
a fresh random nonce. "Authenticated" matters: any tampering with the stored
bytes (a flipped bit, a truncated file, a malicious rewrite) makes decryption
fail loudly, and Syncrypt then refuses to touch your vault with that data.
Corrupted input is never applied, ever.

Files in storage get meaningless names derived through a keyed hash — no
filenames, no folder structure visible.

**What your storage provider can see:** how many objects you store, their
sizes, and when you sync. **What it cannot see:** any content, any filename,
any folder name, or which note changed.

## What protects your notes when things go wrong

| If… | then… |
|---|---|
| someone reads your bucket | they see ciphertext and opaque names — nothing else |
| someone tampers with your bucket | decryption fails loudly; nothing bad is applied |
| someone steals your bucket credentials | they can delete or corrupt ciphertext (availability), not read notes — enable bucket versioning and keep a backup |
| your device dies mid-sync | the design commits changes only after uploads finish; the next sync simply completes or safely re-plans |
| you delete files by accident and sync | deletions land in a local trash folder on other devices; previous file versions are retained; bulk deletions require your explicit confirmation first |

One honest limitation: the plugin stores your storage credentials (not the
passphrase!) in Obsidian's plugin settings file, unencrypted — they're needed
before any key exists. Use least-privilege credentials scoped to one bucket,
and treat that file like a key to the ciphertext, not to the notes.

## The exit door

Trust, but verify: with only your passphrase and a copy of your bucket, a
short script using standard open-source libraries (Argon2id + HKDF + AES-GCM)
restores your entire vault. Both a Node.js and a Python version ship in this
repository and are tested against real Syncrypt output —
[manual recovery](./user-guide/manual-recovery.md).

If Syncrypt disappeared tomorrow, your notes wouldn't.

## Reporting security issues

Privately, please — see [SECURITY.md](../SECURITY.md).
