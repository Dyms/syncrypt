# Cryptography Rationale

Why each primitive was chosen. Normative spec: [RFC-0005](../rfc/RFC-0005-Encryption-Model.md).
Principle: **boring, vetted primitives; never roll our own.**

## Primitives

### Key derivation — Argon2id
- **Why:** memory-hard KDF, winner of the Password Hashing Competition, resistant
  to GPU/ASIC brute force. `id` variant balances resistance to side-channel and
  GPU attacks.
- **Parameters (final, M2):** salt is a random **128-bit** value stored in the
  clear (non-secret) in `meta/keyfile-params.json`, **base64-encoded** (standard
  alphabet, with padding). Defaults, chosen by benchmark (hash-wasm WASM,
  Node 24, Intel i7-8700K @ 3.7 GHz, single thread — 2026-07-16):

  | preset | memory | iterations | parallelism | measured |
  |---|---|---|---|---|
  | **desktop (default)** | 128 MiB (`memoryKiB: 131072`) | 3 | 1 | ~431 ms |
  | **mobile profile** | 32 MiB (`memoryKiB: 32768`) | 4 | 1 | ~136 ms (desktop; expect 2–4× on phones) |
  | OWASP minimum (reference) | 19 MiB | 2 | 1 | ~41 ms |

  Rationale: unlock happens once per session, so we buy substantially more
  brute-force cost than the OWASP floor while keeping WASM heap growth safe on
  modest hardware; the mobile profile trades memory (webview limits) for an
  extra pass. Re-run `node scripts/bench-argon2id.mjs` to re-tune.
  Implementations MUST reject out-of-range parameters from a poisoned keyfile,
  fail closed. Upper (anti-DoS) bounds: memory ≤ 1 GiB, iterations ≤ 100,
  parallelism ≤ 16. Lower (anti-downgrade, ADR-0014) floor: memory ≥ 19 MiB
  (19456 KiB), iterations ≥ 2 — a keyfile weaker than the OWASP reference is refused
  instead of OOM.
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
  and, keyed (HMAC-style), for object keys. Fast hashing matters when sc