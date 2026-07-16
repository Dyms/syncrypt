# Migrating from Self-hosted LiveSync

Syncrypt and LiveSync are different by design (ADR-0001). Migration is a clean
cut-over, not an in-place upgrade.

## Recommended approach (safest)

1. **Back up first.** Make a full copy of your vault folder somewhere safe.
   Encryption is not a backup.
2. **Start from a clean vault** if your old vault accumulated LiveSync artifacts
   or plugin cruft. Create a new vault and copy your notes/attachments in — this
   is exactly what the author did to escape old glitches.
3. **Disable / remove** Self-hosted LiveSync in the new vault so two sync systems
   never run at once.
4. **Install Syncrypt**, configure storage + passphrase, pick a profile
   ([configuration](./configuration.md)).
5. **Sync now** on the first device (initial encrypted upload).
6. On each other device, install Syncrypt with the **same** storage + passphrase
   and **Sync now** to pull.

## Notes

- Do **not** point Syncrypt and LiveSync at the same vault simultaneously.
- LiveSync's CouchDB is irrelevant to Syncrypt; you can decommission it once
  you've confirmed all devices are converged on Syncrypt.
- Keep your original backup until you have run the three-device loop successfully
  for a while.
