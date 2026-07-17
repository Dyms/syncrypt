# ADR-0016: Secret storage in the Obsidian client

- **Status:** Accepted
- **Date:** 2026-07-17
- **Related:** RFC-0005, ADR-0003, ADR-0014, threat-model (A4, A5)

## Context

The plugin needs two secrets: the **passphrase** (→ key ring) and the **S3
credentials**. `meta/keyfile-params.json` lives in the bucket, so credentials
are required *before* any key exists — encrypting them under a
passphrase-derived key is circular (the Argon2id salt is in the bucket).
Obsidian's plugin sandbox exposes no reliable OS-keychain / Electron
`safeStorage` API, and third-party plugins share the process (threat-model A5).

## Decision

1. **The passphrase is never persisted.** It is entered in an unlock modal;
   the derived subkeys live only in process memory, at most until Obsidian
   quits (plugin unload clears them). A **Lock** command drops keys
   immediately. The passphrase never reaches `data.json`, logs, or settings —
   asserted by a test.
2. **S3 credentials are stored in the plugin's `data.json` in plaintext**,
   with an explicit warning in the Settings UI recommending **least-privilege
   keys** (single bucket/prefix, no admin rights) and **bucket versioning**.
   This is a deliberate v1 trade-off: the alternatives either destroy the
   daily-drive UX or add complexity without changing the A4/A5 exposure.
3. The threat model gains a row: `data.json` is readable by any local process
   or co-resident plugin → impact is limited to *ciphertext* access and
   availability (A3-equivalent); note confidentiality is protected by the
   passphrase, which is not on disk.

## Options considered

- **OS keychain / Electron safeStorage** — no plugin API today; revisit as
  future hardening if Obsidian exposes one.
- **Credentials encrypted under the passphrase** — circular with
  keyfile-params in the bucket; caching the salt locally breaks the cycle but
  a lost cache falls back to plaintext anyway — complexity without a real
  security win against A4/A5. Rejected for v1.
- **Prompt for credentials every launch** — unusable daily; rejected.
- **Plaintext credentials + never-persisted passphrase (chosen)** — honest,
  documented exposure; the high-value secret (note contents) stays protected.

## Consequences

- Transparent security model, warned about in the UI itself.
- A stolen `data.json` yields bucket access (= ciphertext + availability
  damage), not note contents.
- Re-evaluate when Obsidian ships a secure-storage API.
