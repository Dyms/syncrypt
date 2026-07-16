# ADR-0003: Client-side E2EE with AES-256-GCM + Argon2id

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0005, docs/security/cryptography.md

## Context

Storage may be third-party/commodity (S3). Notes are private. The provider must be
treated as untrusted. We must not invent crypto and must stay portable (desktop +
Android) and hand-recoverable.

## Decision

Encrypt all content and the manifest **client-side** before upload. Derive a master
key from the user passphrase with **Argon2id**; encrypt objects with **AES-256-GCM**
using fresh random 96-bit nonces; separate subkeys via HKDF-SHA-256. The provider
stores only ciphertext.

## Options considered

- **Provider-side / at-rest encryption only** — provider can read plaintext;
  rejected (violates "user owns the data").
- **age/PGP file encryption** — good primitives but awkward for per-file keys,
  manifest, and rotation; AES-GCM + HKDF chosen for fit and portability.
- **XChaCha20-Poly1305** — fine alternative; AES-256-GCM chosen for ubiquitous
  hardware acceleration and WebCrypto availability. Revisit if nonce-misuse
  resistance becomes needed.

## Consequences

- Zero-knowledge of *contents*; some metadata (sizes, counts, timing) still leaks
  (documented in RFC-0005 + threat model).
- Passphrase loss = data loss (by design). Recovery guidance in the user guide.
- Requires Argon2id on all platforms (WASM/native on mobile).
