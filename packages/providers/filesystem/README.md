# @syncrypt/provider-filesystem

Local-folder / external-drive `StorageProvider`. Excellent for offline backups,
air-gapped copies, and as the reference implementation in tests (no network, fully
deterministic). Passes the shared conformance suite.

Status: **implemented** — passes the shared conformance suite in both
capability modes (conditional writes on/off), plus a filesystem `VaultPort`
adapter used by the two-device end-to-end fuzz.
