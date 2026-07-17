# Migrating from Self-hosted LiveSync

Syncrypt and LiveSync are different by design (ADR-0001). Migration is a clean
cut-over, not an in-place upgrade.

## Recommended approach (safest)

1. **Back up first.** Make a full copy of your vault folder somewhere safe.
   Encryption is not a backup.
2. **Start from a clean vault** if your old vault accumulated LiveSync artifacts
   or plugin cruft. Create a new vault and copy your notes/attachments in — this
   is exactly what the author did to escape old glitches.
3. **Disable AND remove** Self-hosted LiveSync in the new vault so two sync
   systems never run at once. Syncrypt's **preflight check** warns at unlock if
   it finds LiveSync (or another sync plugin — Remotely Save, Obsidian Git)
   enabled or left over — it warns only, it never touches other plugins;
   resolving is your call.
4. **Install Syncrypt**, configure storage + passphrase, pick a profile
   ([configuration](./configuration.md)).
   - Keep the **cross-device KDF profile** (the default) if any of your devices
     is a phone — a "desktop-only vault" cannot be unlocked on mobile
     (ADR-0018).
5. **Sync now** on the first device (initial encrypted upload). The first
   device creates `meta/keyfile-params.json`; the passphrase itself is never
   uploaded or stored.
6. On each other device, install Syncrypt with the **same** storage settings +
   passphrase and **Sync now** to pull. A wrong passphrase fails safely with a
   clear error — nothing is applied.

## Verify before trusting

- Run an edit → sync → edit loop across all devices; check the **sync log**
  (one line per file, with the reason) matches what you expect.
- Delete a throwaway note on one device and confirm it lands in
  `.obsidian/sync-trash/` on the others — never hard-deleted.
- Only then decommission LiveSync's CouchDB. It is irrelevant to Syncrypt.

## Notes

- Do **not** point Syncrypt and LiveSync at the same vault simultaneously —
  the preflight warning exists precisely because this silently corrupts sync
  state in both systems.
- LiveSync's E2E passphrase and Syncrypt's passphrase are unrelated; pick a
  strong, unique one and store it in a password manager (losing it means
  losing the data — by design).
- Bulk operations: if your first sync would delete/overwrite many files,
  Syncrypt pauses and shows the full list (Safe Sync) — read it before
  confirming; that pause is the guard against the exact incident that
  motivated this project.
- Keep your original backup until you have run the three-device loop
  successfully for a while.
