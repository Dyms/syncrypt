# @syncrypt/provider-s3

S3-compatible `StorageProvider`: get/put/stat/list/delete, multipart upload for
large objects, retries with backoff + jitter, and **honestly probed conditional
writes** (If-Match / If-None-Match are honored only when a one-time probe
observes real 412s — RFC-0006). Manifest safety never depends on them: the
engine's LIST-based protocol (ADR-0006) works on any vendor.

Built on `fetch` + SigV4 (`aws4fetch`) instead of the AWS SDK so the same code
can run in the Obsidian mobile webview — see
[ADR-0015](../../../docs/adr/ADR-0015-S3-Client-Strategy.md).

Notes:

- **Path-style** addressing is the default (`forcePathStyle: true`) — works on
  MinIO, R2, Ceph, and AWS alike; switch to virtual-hosted per endpoint needs.
- `capabilities().objectVersioning` is reported `false` (probing it would need
  extra IAM permissions); enable bucket versioning yourself — recommended by
  the [threat model](../../../docs/architecture/threat-model.md).
- Credentials come from config, live only in signed requests, and never appear
  in logs or error messages (unit-asserted).
- SigV4 is clock-sensitive: a badly skewed device clock surfaces as
  `StorageUnauthorized`.

Testing: unit suites run everywhere; the RFC-0006 conformance suite, multipart,
and the encrypted SDK e2e run against a live MinIO when
`SYNCRYPT_S3_TEST_ENDPOINT` is set (CI provides one).

Spec: [RFC-0006](../../../docs/rfc/RFC-0006-Storage-Provider-API.md),
concurrency: [ADR-0006](../../../docs/adr/ADR-0006-Manifest-Concurrency-Control.md).
Status: **implemented (M3)**.
