# ADR-0014: Keyfile KDF parameter floor (anti-downgrade)

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0005, ADR-0003, threat-model (A3)
- **Target:** M3 (few lines + a test). M2 shipped upper anti-DoS bounds only.

## Context

`meta/keyfile-params.json` stores the Argon2id salt + parameters **in the clear
and unauthenticated**. M2 correctly rejects *absurdly large* parameters (a
poisoned keyfile can't OOM a device: memory ≤ 1 GiB, iterations ≤ 100,
parallelism ≤ 16). But it enforces **no lower bound** beyond the algorithm
minimums, so a keyfile declaring `memoryKiB: 8, iterations: 1` is accepted.

Threat: an attacker with bucket **write** access (threat-model A3) who seeds a
**weak** keyfile before a vault's first device bootstraps can cause the whole
vault to be encrypted under a weak Argon2id configuration, lowering the cost of
an offline passphrase brute-force if they also capture ciphertext.

Scope of exposure: for an *existing* vault, changing the parameters changes the
derived master key, so a joining device simply fails to decrypt (a join-time
**DoS**, fail-closed — not a confidentiality break). The real exposure is the
**fresh-bootstrap** case, where a device adopts an attacker-seeded weak keyfile
for the very first encryption.

## Decision

Enforce a **minimum KDF strength floor** on keyfile parse, in addition to the
existing maximum bounds. Parameters below the floor are rejected as
`CryptoAuthError` (fail closed). The floor applies both when generating a new
keyfile (defaults already exceed it) and when adopting an existing one.

Floor (OWASP reference minimum for Argon2id): **`memoryKiB ≥ 19456` (19 MiB)**,
**`iterations ≥ 2`**, `parallelism ≥ 1`. The shipped desktop (128 MiB/t3) and
mobile (32 MiB/t4) profiles sit comfortably above it.

## Options considered

- **Upper bounds only (M2 state)** — stops DoS, not downgrade; insufficient.
- **Minimum floor (chosen)** — closes the bootstrap-downgrade vector; trivial cost.
- **Authenticated keyfile (verifier token encrypted under MK)** — detects *any*
  keyfile tampering explicitly rather than as a downstream decrypt failure.
  Stronger, but more moving parts; **deferred** as an optional future hardening.
  The floor is the v1 mitigation.

## Consequences

- Devices refuse to create or join a vault whose KDF is dangerously weak.
- A few lines in `packages/crypto/src/keys.ts` + a rejection test.
- Update `cryptography.md` (MUST now covers a floor as well as a ceiling) and add
  a threat-model line for keyfile-params integrity/downgrade.
