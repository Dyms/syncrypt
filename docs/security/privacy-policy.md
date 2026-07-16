# Privacy Policy

Syncrypt is a local tool that talks only to storage **you** configure.

## What Syncrypt collects

**Nothing.** There is no telemetry, no analytics, no crash reporting, no usage
tracking, and no network calls other than to the storage backend you configure.
This is a hard product principle (RFC-0001), not a toggle.

## What leaves your device

- **Encrypted** file objects and an **encrypted** manifest, sent only to the
  S3-compatible (or future) storage endpoint **you** specify.
- KDF parameters and a salt (non-secret) needed to re-derive your key on another
  of your devices.

Your passphrase and encryption keys **never** leave the device in any form.

## What the storage provider can see

Because encryption is client-side, your provider sees ciphertext. It can still
observe object sizes, counts, and timing (see the
[threat model](../architecture/threat-model.md)). Choose a provider you are
comfortable with on that basis.

## Third parties

None are involved by Syncrypt. Your relationship is directly with your storage
provider under their terms.

## Changes

Any change to this stance would be a significant, visible decision recorded as an
ADR — not a quiet edit.
