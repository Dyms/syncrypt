# Tests

Tests live next to the code they hold: `packages/*/test`. Run everything with
`npx vitest run` from the repository root.

- **Planner**: golden fixtures and property-based tests asserting the core
  invariants (no data loss, no silent overwrite) — `packages/core/test`.
- **Provider conformance**: one suite run against every storage provider.
- **End to end**: encrypted sync across devices against in-memory storage; with
  `SYNCRYPT_S3_TEST_ENDPOINT` / `SYNCRYPT_WEBDAV_TEST_ENDPOINT` set, against a
  real S3-compatible or WebDAV server (skipped otherwise).
- **Review regressions**: `postfix-*` folders hold one reproducer per defect an
  audit found. The property-based fuzzers there are off by default
  (`REVIEW_FUZZ=1`, `REVIEW6_FUZZ=1`).
