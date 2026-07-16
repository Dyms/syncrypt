# Cryptography Rationale

Why each primitive was chosen. Normative spec: [RFC-0005](../rfc/RFC-0005-Encryption-Model.md).
Principle: **boring, vetted primitives; never roll our own.**

## Primitives

### Key derivation — Argon2id
- **Why:** memory-hard KDF, winner of the Password Hashing Competition, resistant
  to GPU/ASIC brute force. `id` variant balances resistance to side-channel and
  GPU attacks.
- **Parameters:** tuned per platform (desktop can afford more memory than Android).
  Benchmarked before M2. Salt is a random 128-bit value stored in the clear
  (non-secret) in `meta/keyfile-params.json`.
- **Alternatives:** scrypt (older, fine), PBKDF2 (weak against GPUs — rejected as
  primary).

### Symmetric encryption — AES-256-GCM
- **Why:** authenticated encryption (confidentiality + integrity in one),
  hardware-accelerated on virtually all modern CPUs and phones, available in
  WebCrypto everywhere (desktop + Obsidian mobile). The GCM tag gives us
  tamper detection for free (fail-closed on mismatch).
- **Nonce:** 96-bit random per encryption. Per-file, fresh nonces keep collision
  probability negligible at our scale.
- **AAD:** the object header (magic|version|alg|nonce) is authenticated, preventing
  version downgrade or header tampering.
- **Alternatives:** XChaCha20-Poly1305 (excellent, larger nonce → simpler
  nonce-misuse story). Kept as a documented fallback; AES-GCM chosen for hardware
  acceleration + WebCrypto ubiquity. If we later adopt deterministic per-object
  keys, we will switch to a nonce-misuse-resistant AEAD (AES-GCM-SIV).

### Subkey separation — HKDF-SHA-256
- **Why:** derive independent Content/Manifest/Name keys from the master key so a
  problem in one role cannot affect another. Standard, simple, well-understood.

### Content hashing — BLAKE3
- **Why:** very fast, parallel, modern; used for change detection (over plaintext)
  and, keyed (HMAC-style), for object keys. Fast hashing matters when scanning
  1,000+ notes and large attachments.
- **Note:** the change-detection hash is over **plaintext** so a device can detect
  its own edits without decrypting anything; privacy implications are analyzed in
  RFC-0005 and the threat model.

## What the crypto does NOT hide (v1)

Object **sizes**, object **counts**, and **timing** of operations remain visible to
the storage operator. Padding/obfuscation is deferred (RFC-0005 §Metadata
trade-offs). This is stated openly so users with a stricter threat model can add
their own controls.

## Implementation rules

- Use platform crypto (WebCrypto `SubtleCrypto`) for AES-GCM and HKDF; a vetted
  WASM/native library for Argon2id and BLAKE3.
- Never log keys, passphrases, or nonces-with-plaintext.
- Zeroize key material where the platform allows; keep secrets short-lived.
- Version the crypto format (`version` byte) so we can evolve safely.
