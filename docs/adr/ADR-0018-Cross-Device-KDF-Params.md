# ADR-0018: Cross-device Argon2id parameters

- **Status:** Accepted
- **Date:** 2026-07-17
- **Related:** RFC-0005, ADR-0014, docs/security/cryptography.md, overview.md
  (compatibility matrix)

## Context

`meta/keyfile-params.json` is vault-wide: every joining device MUST derive with
exactly the stored parameters — anything else produces a different key. The M2
creation default was the desktop profile (128 MiB / t=3), which WASM Argon2id
can OOM or badly lag inside a low-end Android webview. The first device was
silently choosing parameters that another of the user's own devices could not
afford.

## Decision

1. **The default vault-creation profile is cross-device-safe:
   32 MiB / t=4 / p=1** (`CROSS_DEVICE_KDF_PRESET`; ≈136 ms desktop, an
   estimated 0.3–1 s on phones; comfortably above the ADR-0014 floor of
   19 MiB / t=2).
2. **The heavier desktop profile (128 MiB / t=3) is an explicit opt-in** —
   a "desktop-only vault" choice at creation time, with a warning that mobile
   devices will refuse to join such a vault.
3. **Affordability ceiling:** `openVaultCrypto` accepts
   `affordability.maxMemoryKiB`; the mobile client passes 128 MiB. Stored
   parameters above the ceiling are refused **fail-closed**
   (`CryptoAuthError`) with an actionable message — never a silent webview
   OOM/crash. Parameters are NEVER adapted downward (that would change the
   key); the guard also applies when creating a fresh vault.
4. A device never silently picks parameters another device cannot afford:
   exceeding the cross-device default requires an explicit user action.

## Options considered

- **Keep 128 MiB as the creation default** — punishes the mobile scenario the
  project exists for; rejected.
- **Per-device parameters with a wrapped master key** — two KDF paths and a
  more complex keyfile break the "30-line manual recovery" guarantee; rejected
  for v1.
- **Auto-downgrade at join time** — impossible: different params = different
  key; rejected.
- **Cross-device default + explicit desktop-only opt-in + fail-closed
  affordability ceiling (chosen).**

## Consequences

- New vaults are mobile-joinable by default; brute-force cost of the default
  drops versus the desktop profile but stays well above the OWASP floor —
  and unlock happens once per session.
- Vaults created before this ADR with the desktop profile refuse mobile join
  with a clear message; the documented remedy is recreating the vault with
  cross-device params (same passphrase, data re-uploads).
- `MOBILE_KDF_PRESET` becomes an alias of `CROSS_DEVICE_KDF_PRESET`.
