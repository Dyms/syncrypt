# ADR-0015: S3 client — fetch + SigV4, not the AWS SDK

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0006, RFC-0003 (portability), ROADMAP M5

## Context

`@syncrypt/provider-s3` needs an S3 client. The same provider must eventually
run inside the Obsidian **mobile** webview (M5), where Node-only APIs are
unavailable and bundle size matters. Syncrypt uses a deliberately tiny slice of
the S3 API: PUT/GET/HEAD/DELETE object, ListObjectsV2, and multipart upload.

## Decision

Use **`fetch` + SigV4 signing via `aws4fetch`** (a ~7 KB, widely used signer)
and implement the small S3 REST surface directly, including minimal
`ListObjectsV2`/multipart XML parsing (requests always use `encoding-type=url`,
so key escaping is trivial). Correctness is guarded by unit tests on mocked
`fetch` plus the shared RFC-0006 conformance suite against a live MinIO in CI,
in both capability modes.

## Options considered

- **`@aws-sdk/client-s3` (official v3)** — battle-tested and complete, but
  megabytes of Node-leaning dependencies; awkward-to-hostile inside a mobile
  webview plugin; vastly more API than we use. Rejected for the reference
  provider (nothing prevents an alternative provider using it later).
- **Hand-rolled SigV4 too** — signing is subtle (canonicalization, payload
  hashing, clock skew) and exactly the kind of code we should not own; rejected.
- **`fetch` + `aws4fetch`, minimal REST (chosen)** — portable (browser, Node
  ≥ 18, mobile webviews), small, and the owned surface (a dozen XML fields) is
  fully covered by tests.

## Consequences

- The provider runs anywhere `fetch` exists — the M5 mobile path needs no rework.
- We own ListObjectsV2/multipart XML parsing; the conformance suite against a
  real backend is the safety net (and would catch vendor XML quirks).
- SigV4 is clock-sensitive; devices with badly skewed clocks will see
  `StorageUnauthorized` (documented in troubleshooting).
- Conditional-write support varies by vendor, so `capabilities()` is backed by
  a one-time **active probe** (observed 412s, not vendor claims) — honest per
  RFC-0006.
