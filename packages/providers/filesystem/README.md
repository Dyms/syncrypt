# @syncrypt/provider-filesystem

Local-folder / external-drive `StorageProvider`. Excellent for offline backups,
air-gapped copies, and as the reference implementation in tests (no network, fully
deterministic). Passes the shared conformance suite.

Spec: [RFC-0006](../../../docs/rfc/RFC-0006-Storage-Provider-API.md).
Status: **implemented (M1)** — passes the shared conformance suite in both
capability modes (conditional writes on/off), plus a filesystem `VaultPort`
adapter used by the two-device end-to-end fuzz.
