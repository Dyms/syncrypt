# @syncrypt/provider-webdav

WebDAV `StorageProvider` (Nextcloud, Apache mod_dav, and friends). Implements
the universal object subset (`put`/`get`/`list`/`delete`/`stat`) and reports
`capabilities()` honestly: **`conditionalWrites: false`** — manifest safety
rides entirely on the LIST-based protocol
([ADR-0006](../../../docs/adr/ADR-0006-Manifest-Concurrency-Control.md)),
which is exactly why this provider exists: it proves the abstraction with a
second, protocol-different backend.

Mapping: `get`=GET · `put`=PUT (missing parent collections created via MKCOL
on 409) · `delete`=DELETE (404 = success) · `stat`=PROPFIND Depth:0 ·
`list`=PROPFIND Depth:1 walked recursively (Depth:infinity is often disabled
server-side). Auth: Basic or Bearer. No multipart — WebDAV is one PUT per
object. Injectable transport (RFC-0006): Obsidian clients pass the same
`requestUrl()`-backed transport as for S3.

Testing: the shared RFC-0006 conformance suite and an encrypted two-device
e2e run against a real in-process WebDAV server on every test run (no setup
needed); CI additionally runs them against an Apache mod_dav container via
`SYNCRYPT_WEBDAV_TEST_ENDPOINT`.

Spec: [RFC-0006](../../../docs/rfc/RFC-0006-Storage-Provider-API.md).
Status: **implemented (M6)**.
