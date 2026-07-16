# RFC-0005: Encryption Model

- **Status:** Accepted
- **Author(s):** Dmitriy (project author)
- **Created:** 2026-07-16
- **Related ADRs:** ADR-0003
- **See also:** [threat model](../architecture/threat-model.md),
  [cryptography rationale](../security/cryptography.md)

## Summary

All vault content and the manifest are encrypted **client-side** before upload.
The storage backend is untrusted and is expected to hold only ciphertext. Keys
are derived from a user **passphrase** with **Argon2id**; files are encrypted with
**AES-256-GCM** using a fresh random nonce per encryption. This RFC specifies the
key hierarchy, the on-storage formats, how the manifest and paths are handled, and
key rotation.

## Design constraints

- **Boring, vetted primitives only.** No custom constructions.
- **Zero-knowledge intent:** the provider should learn as little as feasible.
  Absolute metadata hiding is out of scope for v1 (see §Metadata trade-offs), but
  file *contents* are never exposed.
- **Hand-recoverable:** given the passphrase and the documented format, a user can
  decrypt any object with a short script and no Syncrypt install (FR-13).
- **Portable:** the scheme must be implementable on desktop and Android without
  Node-only APIs (WebCrypto + a WASM/native Argon2id).

## Key hierarchy

```
passphrase
   │  Argon2id(salt, params)        ← salt & params stored in meta/keyfile-params.json
   ▼
Master Key (MK, 256-bit)
   ├── HKDF("syncrypt/content")  → Content Key (CK)   — encrypts file objects
   ├── HKDF("syncrypt/manifest") → Manifest Key (MFK) — encrypts manifest.json
   └── HKDF("syncrypt/names")    → Name Key (NK)      — HMAC for object keys / path handling
```

- **Argon2id** derives the Master Key from the passphrase. Parameters (memory,
  iterations, parallelism) and a random 128-bit **salt** are stored **in the
  clear** in `meta/keyfile-params.json` — they are not secret; only the passphrase
  is. Defaults and rationale in [cryptography.md](../security/cryptography.md).
- **HKDF-SHA-256** separates subkeys so a single primitive's misuse is contained
  and roles are independent.
- The passphrase and MK exist only in memory. They are **never** written to disk,
  logs, or the manifest.

## File object format

Each encrypted object is a self-describing blob:

```
magic:      "SYNC"                (4 bytes)
version:    uint8                 crypto format version (starts at 1)
alg:        uint8                 1 = AES-256-GCM
nonce:      12 bytes              random per encryption (never reused with a key)
ciphertext: variable             AES-256-GCM(plaintext, key=CK, aad=header)
tag:        16 bytes             GCM authentication tag
```

- The header (magic|version|alg|nonce) is bound as **AAD**, so downgrading the
  version or swapping the nonce fails authentication.
- **Nonce discipline:** 96-bit random nonces. With random nonces and per-file
  encryption, collision probability stays negligible for realistic vault sizes;
  large re-encryptions get fresh nonces. (If we ever move to deterministic keys
  per object, we switch to a nonce-misuse-resistant mode — noted for future RFC.)
- A wrong passphrase or any tampering ⇒ GCM tag verification fails ⇒ Syncrypt
  **refuses to apply** the data (FR-17, fail-closed).

## Manifest encryption

The manifest is encrypted with **MFK** using the same object format. It is the
commit point (RFC-0004) and therefore also the most sensitive metadata artifact:
it lists paths, sizes and change times. Encrypting it means the provider cannot
read your folder structure from the manifest.

## Object keys and path confidentiality

The storage object key must not reveal the plaintext path. Options and the
default:

- **Default (v1):** object key = `HMAC-BLAKE3(NK, contentHash)` (content-addressed
  under the Name Key). This yields immutable, dedup-friendly objects whose keys
  reveal neither the path nor the plaintext, while letting the manifest map
  `path → contentHash → objectKey`.
- The **manifest** (encrypted) holds the `path → {hash,size,mtime}` mapping; the
  provider sees only opaque object keys plus one opaque `manifest.json`.

### Metadata trade-offs (explicit)

Even with the above, the provider can still observe, from ciphertext alone:

- the **number** of objects and their **sizes**,
- **timing** of uploads/downloads,
- total storage growth over time.

Hiding these (padding, size bucketing, fixed-schedule syncs, decoy traffic) costs
efficiency and is **out of scope for v1**. This limitation is stated plainly here
and in the threat model so users can make an informed choice. If a user's threat
model requires it, they can additionally place the bucket behind their own
controls.

## Key storage & unlock

- The passphrase is entered by the user; Syncrypt may cache the derived MK in
  memory for the session.
- Optional (client-dependent): store the MK in the OS secure enclave / keychain,
  never in plaintext files. On Android, use the platform keystore where available.
- `meta/keyfile-params.json` (salt + KDF params, non-secret) is uploaded so a new
  device only needs the passphrase to derive the same MK.

## Key rotation

- **Passphrase change:** re-derive MK from the new passphrase; because subkeys are
  HKDF-derived from MK, rotating the passphrase means re-encrypting the manifest
  and (for full rotation) re-encrypting objects. v1 supports manifest-key rotation
  cheaply; full object re-encryption is a background, resumable operation
  (post-1.0 refinement acceptable).
- **Compromise response:** documented in the threat model — rotate passphrase,
  re-encrypt, and (if the storage credentials leaked) rotate S3 credentials.

## Hand-recovery guarantee

The formats above are documented precisely so that, given the passphrase, a user
can decrypt `manifest.json` and any object with a ~30-line script using standard
libraries (Argon2id + HKDF + AES-GCM). A reference recovery script ships in
`docs/user-guide/` before v1.0. This is a hard requirement, not a nicety: it is
what "user owns the data" means in practice.

## Unresolved questions

- Final object-key strategy (content-addressed vs. path-mapped) — coupled to
  RFC-0004 §Object keys.
- Whether to offer optional size padding as an advanced, opt-in privacy mode.
- Exact Argon2id default parameters per platform (desktop vs. Android memory
  limits) — benchmarked before M2.
