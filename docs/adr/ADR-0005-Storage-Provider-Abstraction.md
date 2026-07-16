# ADR-0005: Storage provider abstraction

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0003, RFC-0006

## Context

S3 is the first backend, but the user may later want WebDAV, R2, OneDrive, or a
local folder. The engine must not be coupled to S3.

## Decision

Define one `StorageProvider` interface (RFC-0006) with blob CRUD + `stat`/`list`,
**conditional writes**, and a `capabilities()` probe. The engine talks only to this
interface. Providers pass a shared conformance suite.

## Consequences

- New backends slot in without engine changes; abstraction proven by a 2nd provider
  (ROADMAP M6).
- Engine must handle capability differences (e.g. no conditional writes) via
  ADR-0006 fallbacks.
