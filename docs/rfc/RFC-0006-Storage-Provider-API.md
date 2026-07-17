# RFC-0006: Storage Provider API

- **Status:** Accepted
- **Author(s):** Dmitriy (project author)
- **Created:** 2026-07-16
- **Related ADRs:** ADR-0005, ADR-0006

## Summary

Defines `StorageProvider` — the single interface the core engine uses to talk to
any backend. S3-compatible storage is the first implementation; the interface is
designed so WebDAV, Cloudflare R2, OneDrive, or a local folder can be added later
without touching the engine. The engine requires only the **universal object
subset — `put` / `get` / `list` / `delete` / `stat`** — because that is all every
S3-compatible vendor guarantees. Manifest safety is built on this subset
(immutable generation objects + LIST, per ADR-0006). **Conditional writes are
optional** and used only as a fast path when a provider advertises them.

## The interface

```ts
/** An opaque storage key, e.g. "objects/ab/cd/ef…" or "manifest.json". */
type ObjectKey = string;

interface ObjectStat {
  key: ObjectKey;
  size: number;
  /** Provider-native version/etag token used for conditional writes. */
  etag: string;
  lastModified: number; // epoch seconds, advisory
}

interface PutOptions {
  /** Succeed only if the current object's etag matches (compare-and-swap). */
  ifMatch?: string;
  /** Succeed only if the object does not exist (create-if-absent). */
  ifNoneMatch?: "*";
  contentType?: string;
}

interface PutResult { etag: string; }

interface StorageProvider {
  /** Upload bytes. With ifMatch/ifNoneMatch, performs a conditional write. */
  put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult>;

  /** Download bytes. Rejects with NotFound if absent. */
  get(key: ObjectKey): Promise<Uint8Array>;

  /** Metadata without downloading the body. */
  stat(key: ObjectKey): Promise<ObjectStat>;

  /** List keys under a prefix (paginated by the provider). */
  list(prefix: string): AsyncIterable<ObjectStat>;

  /** Delete an object. Idempotent: deleting a missing key is not an error. */
  delete(key: ObjectKey): Promise<void>;

  /** Provider capabilities so the engine can adapt (see below). */
  capabilities(): ProviderCapabilities;
}

interface ProviderCapabilities {
  /** True if put() honors ifMatch/ifNoneMatch atomically. */
  conditionalWrites: boolean;
  /** True if the backend keeps prior object versions (bucket versioning). */
  objectVersioning: boolean;
  /** Max single-PUT size before multipart is required, in bytes. */
  maxSinglePutBytes: number;
}
```

### Error contract

Providers normalize failures to a small set the engine understands:

- `NotFound` — key does not exist.
- `PreconditionFailed` — a conditional write lost the race (the engine maps this
  to `Please pull first`).
- `Unauthorized` / `Forbidden` — credentials/permission problem.
- `Transient` — network/5xx; the engine may retry with backoff.
- `RateLimited` — 429/slow-down; retry with backoff + jitter.

## Manifest concurrency (portable by default)

Manifest publication is the commit point (RFC-0004). Two devices pushing near-
simultaneously must not clobber each other. Because conditional writes are **not**
universal, the engine's baseline uses only `list` + `put` + `get`:

- Manifests are immutable objects `manifests/<gen>-<deviceId>.json`. The latest
  state is `list(manifests/)` → highest generation; two at the same top generation
  = a **fork**, resolved deterministically with no data loss.
- Publishing lists first (detect a newer generation → "pull first"), uploads
  content, writes its own uniquely-named manifest, then re-lists to detect a fork.
- Full protocol in [ADR-0006](../adr/ADR-0006-Manifest-Concurrency-Control.md).

If `capabilities().conditionalWrites` is true, the engine additionally uses
`ifNoneMatch: "*"` on the manifest write — a pure optimization. **Erratum
(M1 implementation):** because manifests are per-device keys
(`<gen>-<deviceId>.json`), create-if-absent guards only against overwriting the
*same* key; it cannot prevent two devices creating *different* keys at the same
generation. Forks between devices are therefore always handled by the re-LIST
detection step, conditional writes or not. The engine never relies on
conditional writes for correctness, so it is safe on any S3.

## S3 implementation notes (`@syncrypt/provider-s3`)

- **Conditional writes (optional):** some S3 backends support `If-Match` /
  `If-None-Match` on PUT (AWS since 2024); many do not. The provider MUST
  probe/declare `conditionalWrites` honestly via `capabilities()`. When present,
  the engine uses them as a fast path; when absent, the universal LIST-based
  protocol (ADR-0006) is used. Either way behavior is correct — no vendor-specific
  requirement.
- **Multipart upload** for objects above `maxSinglePutBytes` (large attachments).
- **Listing** maps to `ListObjectsV2` with continuation tokens.
- **Retries:** exponential backoff with jitter on `Transient`/`RateLimited`.
- **Credentials** come from user config; they are secrets and are never logged or
  placed in the manifest.
- **Addressing style:** support both **virtual-hosted** and **path-style**
  (`forcePathStyle`) URLs. Many S3-compatible backends (MinIO, Ceph RGW, some
  self-hosted/regional S3) require path-style; expose it in config and default to
  the mode the endpoint needs.
- **Client:** to stay portable to the Obsidian mobile webview (M5), the reference
  provider uses a lightweight `fetch`-based SigV4 signer (aws4fetch) rather than
  the heavyweight, Node-leaning AWS SDK (ADR-0015). Implications the impl must get
  right: `x-amz-content-sha256` payload hashing (per-part for multipart), correct
  request date (SigV4 is clock-sensitive), and its own minimal `ListObjectsV2`
  XML parsing (covered by unit tests + live MinIO conformance).
- **Injectable transport (CORS):** the provider MUST accept an injectable HTTP
  transport (default: global `fetch`). Inside Obsidian (desktop **and** mobile) the
  renderer/webview `fetch` is subject to **CORS**, and S3/MinIO buckets do not send
  permissive CORS headers by default — so a raw `fetch` to storage is blocked. The
  Obsidian client MUST supply a transport backed by Obsidian's `requestUrl()`, which
  issues a native request and bypasses CORS. Decouple **signing** from **dispatch**:
  use aws4fetch's `sign()` to produce a signed request, then send it through the
  injected transport. This is required for the M4 live-S3 validation to work at all
  and is mandatory on mobile (M5).

## Conformance test suite

A single **provider conformance suite** lives in `@syncrypt/core` (test utils) and
runs against any `StorageProvider`, asserting:

- round-trip `put`/`get`/`stat`/`delete`;
- `list` pagination correctness;
- conditional-write semantics (or correct capability reporting when unsupported);
- idempotent delete;
- error normalization.

A new provider is "done" when it passes this suite. This is how the abstraction is
proven (ROADMAP M6 adds a second provider specifically to validate it).

## Future providers (post-1.0, non-binding)

The provider axis is meant to grow **without changing the engine**. Candidates,
each just another `StorageProvider` passing the conformance suite:

- **S3-family (S3-compatible API):** AWS S3, Cloudflare **R2**, **Backblaze** B2,
  **MinIO**, Wasabi, Ceph RGW — often share most of `@syncrypt/provider-s3`.
- **WebDAV:** Nextcloud and friends.
- **Consumer clouds (native APIs):** **Dropbox**, **Google Drive**, **OneDrive**.
- **Filesystem:** local folder / external drive — offline backups, air-gapped
  copies, and the deterministic test backend.

Adding a provider is purely additive: implement `StoragePort`, declare
`capabilities()`, pass the conformance suite. The user picks a provider in
settings and never has to verify low-level capabilities themselves — the engine
adapts automatically.

## Unresolved questions

- Whether to expose a batch/pipelined `put` for many small objects to cut request
  overhead on a 1,000-note initial upload.
- Standard config schema shared across providers vs. per-provider config blocks.
