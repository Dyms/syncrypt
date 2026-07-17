# Security Policy

Syncrypt handles private notes and encryption keys. We take that seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report
privately to the maintainer (contact to be listed here before the first
release). Include:

- a description and impact assessment,
- reproduction steps or a proof of concept,
- affected component/version.

You will get an acknowledgement, and we will coordinate a fix and disclosure
timeline with you.

## Scope

In scope: the sync engine, encryption model, key handling, the S3 provider, and
the Obsidian plugin. Out of scope: the security of the object storage you
provide and operate, and your device/OS security.

## Security model in brief

- **End-to-end encryption**: data is encrypted on the client (AES-256-GCM) with a
  key derived from your passphrase (Argon2id) before it leaves the device. The
  storage backend is treated as untrusted. See
  [how security works](./docs/security.md).
- **No secrets in logs**: passphrases and keys are never written to the sync log
  or telemetry (there is no telemetry).
- **Fail closed**: on authentication-tag failure or ambiguous state, Syncrypt
  stops and asks the user rather than proceeding.

## Cryptography

Rationale for algorithm choices lives in
[`docs/security/cryptography.md`](./docs/security/cryptography.md). We do not roll
our own primitives; we use vetted implementations.
