# @syncrypt/provider-s3

S3-compatible StorageProvider: get/put/stat/list/delete, multipart upload for large
objects, and **conditional writes** (ETag / If-Match / If-None-Match) for atomic
manifest publication. Validated against REG.RU S3 and AWS S3.

Spec: [RFC-0006](../../../docs/rfc/RFC-0006-Storage-Provider-API.md),
concurrency: [ADR-0006](../../../docs/adr/ADR-0006-Manifest-Concurrency-Control.md).
Status: not yet implemented — see [ROADMAP M3](../../../ROADMAP.md).
