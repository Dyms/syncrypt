# Glossary

- **Vault** — the Obsidian folder of notes/attachments under sync. Source of truth.
- **Manifest** — encrypted JSON describing intended vault state; the coordination
  point and commit target. Has a monotonic `generation`.
- **Base** — the last manifest a device successfully synced against (a cache).
- **Object** — one encrypted blob in storage (a file version).
- **Tombstone** — a manifest record that a path was deleted.
- **Generation** — monotonic integer incremented on each successful manifest publish.
- **Conflict** — a file changed differently on two sides; surfaced, never merged.
- **Push / Pull** — upload local changes / download remote changes.
- **Sync profile** — YAML include/exclude rules deciding what is synced.
- **StorageProvider** — the backend interface (S3 first).
- **Ports** — interfaces the pure core depends on (Storage/Vault/Crypto/Clock/Log).
- **Safe Mode** — default conservative behavior: stop rather than act destructively.
- **KDF params / keyfile-params.json** — non-secret Argon2id salt+params, uploaded
  so a new device can derive the key from the passphrase.
- **MK / CK / MFK / NK** — Master Key and HKDF-derived Content/Manifest/Name keys.
