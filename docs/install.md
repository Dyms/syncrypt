# Install & setup

*Русская версия: [docs/ru/install.md](./ru/install.md)*

Syncrypt is currently in beta and installs via
[BRAT](https://github.com/TfTHacker/obsidian42-brat) (the standard way to try
pre-release Obsidian plugins). The steps are the same on Windows, macOS, and
Android.

## 1. Install BRAT

Obsidian → **Settings → Community plugins** → Browse → search **"BRAT"** →
Install → Enable.

## 2. Add Syncrypt through BRAT

1. **Settings → BRAT → Add beta plugin.**
2. Enter the repository: `Dyms/syncrypt`.
3. Confirm; BRAT downloads the latest release.
4. **Settings → Community plugins** → enable **Syncrypt**.

Updates: BRAT checks for new releases; "Check for updates" in BRAT pulls the
newest beta.

## 3. Prepare storage (once, any device)

You need either an **S3-compatible bucket** or a **WebDAV folder**.

**S3 (AWS, MinIO, Cloudflare R2, hosting-provider S3, …):**

- Create a bucket dedicated to this vault.
- Create credentials with **least privilege**: access to this one bucket only,
  no admin rights. Syncrypt never needs to create or delete buckets.
- Strongly recommended: enable **bucket versioning** — it's your safety net
  against anyone (or anything) with write access damaging the ciphertext.

**WebDAV (Nextcloud, Apache, …):** create a dedicated folder and, if your
server supports it (Nextcloud does), a dedicated **app password**.

## 4. Configure Syncrypt

**Settings → Syncrypt:**

- **S3**: endpoint URL, region, bucket, optional prefix (a subfolder within
  the bucket), access key ID + secret. Leave *path-style addressing* on for
  MinIO/R2/self-hosted; some AWS setups need it off.
- Heads-up: credentials are stored in the plugin's settings file on this
  device (your notes are protected by the passphrase, which is *not* stored).
  That's why least-privilege credentials matter.
- Networking is handled through Obsidian's native requests — no CORS
  configuration needed on your bucket or server.

## 5. First sync

1. Run the **"Syncrypt: Unlock"** command (or the Unlock button in settings).
2. Enter your passphrase. On the very first device this *creates* the vault's
   encryption setup; **choose a strong passphrase and store it in a password
   manager — it cannot be recovered.**
3. Keep the default **cross-device** encryption profile if any of your devices
   is a phone.
4. Run **"Syncrypt: Sync now"**. The first sync encrypts and uploads the whole
   vault; later syncs transfer only changes.

## 6. Every other device

Install the same way (steps 1–2), enter the **same storage settings** and the
**same passphrase**, then **Sync now**. That's all a new device needs.

On Android, defaults are battery- and data-friendly: auto-sync waits for
Wi-Fi (manual sync always works), runs only in the foreground, and an
idle check costs a few kilobytes.

## Migrating from another sync tool?

Turn it off first — two sync systems pointed at one vault will fight. Syncrypt
warns if it detects one. Full guide:
[migration from LiveSync](./user-guide/migration-from-livesync.md).

## If something doesn't work

[Troubleshooting](./user-guide/troubleshooting.md) covers the usual suspects:
wrong-clock "Unauthorized" errors, conflicted copies, the "waiting for Wi-Fi"
status, and more. The **sync log** ("Syncrypt: Show sync log") explains every
action with its reason — start there.
