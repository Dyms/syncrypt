# Threat Model

Scope: Syncrypt's engine, encryption, key handling, S3 provider, and Obsidian
plugin. Complements [RFC-0005](../rfc/RFC-0005-Encryption-Model.md) and
[cryptography.md](../security/cryptography.md). Uses a lightweight STRIDE-ish
framing focused on what matters for a personal, encrypted file sync.

## Assets

1. **Note contents** (highest value).
2. **Vault structure / metadata** (paths, sizes, timing).
3. **The passphrase** and derived keys.
4. **Storage credentials** (S3 access key/secret).
5. **Data integrity / availability** (no loss, no duplication).

## Trust boundaries

- **Trusted:** the user's devices while unlocked, and the user's memory of the
  passphrase.
- **Untrusted:** the storage provider and the network between device and storage.
- **Partially trusted:** the device OS keystore (used opportunistically to cache
  keys), and Obsidian itself (runs our plugin code).

## Adversaries

- **A1 — Honest-but-curious storage operator / anyone with bucket read access.**
  Can read all stored objects and the manifest, list keys, observe sizes/timing.
- **A2 — Network attacker (MITM).** Can observe/modify traffic to storage.
- **A3 — Thief of storage credentials.** Can read/write/delete bucket contents.
- **A4 — Thief of an unlocked device.** Has whatever the OS session exposes.
- **A5 — Malicious/buggy third-party Obsidian plugin** sharing the app process.

## What we defend, and how

| Threat | Mitigation | Residual risk |
|---|---|---|
| A1 reads note contents | Client-side AES-256-GCM; provider sees ciphertext only (RFC-0005) | Sizes, object counts, timing still visible |
| A1 reads folder structure | Manifest encrypted; object keys are HMAC of content, not paths | Number of objects & size distribution leak |
| A2 tampers with data in flight | GCM auth tag + TLS to storage; tampered blobs fail to decrypt (fail-closed) | DoS by dropping/altering traffic (availability, not confidentiality) |
| A2/A1 rolls back to an old manifest | `generation` monotonicity + conditional publish; a stale manifest is detectable; optional manifest history | A determined A3 with write access can attempt rollback — see below |
| A3 deletes/overwrites data | Recommend **bucket versioning** + separate backup; tombstone GC respects grace window | With full write creds, an attacker can still damage availability; encryption still protects confidentiality |
| A3 forges data | Cannot produce valid GCM tags without the key; forged objects fail to decrypt | Availability only |
| A4 steals unlocked device | Keys live in memory/OS keystore only; lock screen protects at rest | If unlocked and app open, notes are readable (inherent) |
| A5 reads plugin memory | Keep secrets minimal & short-lived; no secrets in logs | Shared-process isolation is limited in Obsidian — documented |
| Passphrase brute force | Argon2id with strong params raises cost; strong-passphrase guidance | Weak passphrases remain the user's risk |

## Explicit non-goals (v1)

- **Metadata privacy** (hiding sizes, counts, timing). Padding/obfuscation is
  out of scope; stated plainly so users can decide.
- **Protection against a fully compromised, unlocked device.**
- **Availability against an attacker with valid write credentials.** Encryption
  protects confidentiality and integrity of contents, not availability — hence
  the strong recommendation for **bucket versioning and independent backups**.

## Integrity & rollback

The manifest's `generation` is monotonic and publication uses immutable
per-generation objects with LIST-based fork detection (ADR-0006). A rollback to an
older manifest by an entity with write access is the main integrity concern. Countermeasures considered:

- Keep a small **append-only history** of manifest generations (also enables
  point-in-time recovery) — attractive, likely post-1.0.
- Client remembers the highest `generation` it has seen; a lower one is refused
  and surfaced as an anomaly.

## Recommendations to the user

- Use a **strong, unique passphrase**; losing it means losing the data (by design).
- Enable **bucket versioning** and keep at least one **independent backup**
  (encryption is not backup).
- Restrict S3 credentials to the single bucket/prefix with least privilege.
- Treat the passphrase as unrecoverable; store it in a password manager.
