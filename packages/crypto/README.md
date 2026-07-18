# @syncrypt/crypto

The reference `CryptoPort` implementation (RFC-0005, ADR-0003):

- **Argon2id** (hash-wasm, WASM) derives the Master Key from the passphrase;
  salt + params live in non-secret `meta/keyfile-params.json`.
- **HKDF-SHA-256** (WebCrypto) separates Content / Manifest / Name keys.
- **AES-256-GCM** (WebCrypto) blobs: `"SYNC" | ver | alg | nonce(12) | ct | tag(16)`,
  header bound as AAD. Tamper or wrong passphrase ⇒ `CryptoAuthError` (fail-closed).
- **BLAKE3** content hashing over plaintext; object keys via BLAKE3 keyed mode
  under the Name Key.

No Node-only APIs — runs in browsers, Node ≥ 20, and mobile webviews. Keys are
memory-only and never logged or persisted.

Rationale: [cryptography.md](../../docs/security/cryptography.md) ·
recovery: [manual-recovery.md](../../docs/user-guide/manual-recovery.md).
