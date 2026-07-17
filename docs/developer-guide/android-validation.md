# Android on-device validation (M5 exit checklist)

Automated coverage ends at the webview boundary: the bundle is built
mobile-safe (no Node/Electron API — enforced at build time), the transport is
CORS-proof (requestUrl), and the KDF affordability guard is unit-tested. What
follows must be verified on a real device.

## Setup

1. `npm run build -w @syncrypt/obsidian`; copy `dist/*` into
   `<vault>/.obsidian/plugins/syncrypt/` on the Android device (e.g. via USB
   or a file manager); enable the plugin in Obsidian mobile.
2. Use a vault created with the **cross-device** KDF profile (the default).
   A desktop-only vault must be REFUSED at unlock with the ADR-0018 message —
   that is a test case, not a failure.

## Checklist

- [ ] **Unlock**: enter the passphrase; measure time to "idle" (Argon2id
      32 MiB / t=4 in the webview — expect roughly 0.3–1.5 s; note the device
      model and the number).
- [ ] **Crypto stack loads**: no WASM errors in the console; first sync
      downloads and decrypts existing notes correctly (spot-check content and
      a non-ASCII path, e.g. `резюме.md`).
- [ ] **Three-device loop**: edit on Windows → sync → appears on macOS and
      Android; edit on Android → appears on both desktops. Repeat with a
      deletion (lands in the other devices' `.obsidian/sync-trash/`).
- [ ] **Conflict**: edit the same note on Android and a desktop before
      syncing; expect a conflicted-copy file on all three devices, no data
      lost.
- [ ] **Safe Sync**: delete >20 notes on a desktop, sync, then sync on
      Android — the confirmation modal must list every file and be usable on
      the phone screen.
- [ ] **Wi-Fi-only**: on cellular, make an edit; the status bar shows
      "waiting for Wi-Fi" and no auto-sync happens; manual **Sync now** works;
      back on Wi-Fi the pending change syncs.
- [ ] **Background push**: make an edit, immediately switch apps
      (visibilitychange → hidden); reopen later — the edit should already be
      on the other devices (best-effort; a failure here only delays to the
      next foreground sync).
- [ ] **Foreground-only**: leave Obsidian in the background for an hour — no
      network traffic from the plugin (no daemon).
- [ ] **Battery/data budget**: after a day of normal use, check Android's
      per-app battery and data screens; an idle sync must cost one LIST + one
      manifest GET (a few KB); no polling.
- [ ] **Restart**: kill and reopen Obsidian — unlock prompt appears, and the
      first sync after unlock is a no-op (persisted base, no full reconcile).

Record device model, Android version, unlock timing, and any deviation in the
M5 sign-off note.
