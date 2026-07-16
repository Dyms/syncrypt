# AI Context: Architecture (condensed)

Full: `docs/rfc/RFC-0003-Architecture.md`.

## Layers
- `@syncrypt/core` — PURE. Manifest, change detection, diff/planner, executor.
  Depends only on ports. No I/O, no Node-only APIs.
- `@syncrypt/sdk` — wires a concrete provider + vault adapter + crypto → SyncEngine
  with push()/pull()/sync()/dryRun()/status().
- `@syncrypt/provider-s3` — implements StoragePort (get/put/stat/list/delete +
  conditional write via ETag/If-Match/If-None-Match + capabilities()).
- `@syncrypt/obsidian` — implements VaultPort via Obsidian API; triggers + UI + log.

## Ports (interfaces core depends on)
StoragePort, VaultPort, CryptoPort, ClockPort, LogPort.

## Commit protocol (critical)
1 plan vs fresh remote manifest (etag G) → 2 stop if diverged ("pull first") →
3 upload objects (idempotent, content-addressed) → 4 build manifest gen=G+1 →
5 conditional PUT manifest If-Match:G. Precondition fail ⇒ "pull first".

## Data
Manifest: {version, generation, device, updatedAt, files{path:{hash,size,mtime}},
tombstones}. Hash over PLAINTEXT (BLAKE3). Paths NFC-normalized (ADR-0007).
Object format: magic|version|alg|nonce(12)|ciphertext|tag(16), AES-256-GCM, AAD=header.
Object key default: HMAC-BLAKE3(NameKey, contentHash).
