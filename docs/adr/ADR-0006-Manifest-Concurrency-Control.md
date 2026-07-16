# ADR-0006: Provider-agnostic manifest concurrency

- **Status:** Accepted
- **Date:** 2026-07-16
- **Related:** RFC-0004, RFC-0006

## Context

Manifest publication is the commit point (RFC-0004). Two devices publishing from
the same base must not clobber each other. Syncrypt must run on **any**
S3-compatible store — not just AWS or REG.RU. The only operations guaranteed
everywhere are **PUT, GET, LIST, DELETE**, where PUT is last-writer-wins.
Conditional writes (`If-Match` / `If-None-Match`) are **not** universally
supported: AWS S3 added `If-Match` on PUT only in 2024, and MinIO, Wasabi,
Backblaze B2, Cloudflare R2, Ceph RGW and others differ. We therefore cannot
depend on compare-and-swap for correctness.

## Decision

Use **optimistic concurrency built only on PUT/GET/LIST/DELETE**, which works on
every S3-compatible backend.

1. **Manifests are immutable, uniquely-named objects:**
   `manifests/<gen>-<deviceId>.json` (encrypted), where `<gen>` is the
   zero-padded generation and `<deviceId>` is a stable random per-device UUID.
2. **Current state** = the manifest object with the highest generation. Two
   objects sharing the highest generation = a **fork**.
3. **Publish** generation `N+1` (from base `N`):
   1. `LIST manifests/`; let `Gmax` = highest generation present.
   2. If `Gmax > N` → someone published since your pull → **stop: "pull first"**.
   3. Upload all new encrypted content objects (idempotent, content-addressed —
      re-uploading the same content is a no-op).
   4. `PUT manifests/<N+1>-<myId>.json`.
   5. **Re-LIST.** If another `<N+1>-<otherId>.json` exists → **fork detected** →
      resolve (below). Otherwise the publish succeeded.
4. **Fork resolution** (rare — both devices pushed from the same base at the same
   moment): deterministic. The manifest with the lexicographically smallest
   `<deviceId>` wins and becomes the new base at `N+1`; the loser treats the
   winner as a normal remote and **re-plans its own changes against it**,
   surfacing per-file conflicts per RFC-0004. **No data is lost** — both
   manifests and all their content objects exist in storage.
5. **Latest pointer (optimization):** optionally also `PUT manifest.json` as a
   copy of the newest manifest for a fast single-GET read. It is only a *hint*;
   the authoritative "latest" is always `LIST manifests/` → max generation → fork
   check. Correctness never depends on the pointer.

### Optional fast path

If `capabilities().conditionalWrites` is true, step 3.4 uses
`If-None-Match: <key>` (create-if-absent) so a duplicate `<gen>-<id>` can never be
created and forks are **prevented** rather than **detected**. This is a pure
optimization layered on top of the universal protocol above.

## Options considered

- **Rely on `If-Match` conditional PUT** — clean CAS, but not portable across
  S3-compatible vendors; rejected as the baseline (kept as optional fast path).
- **Lock object (`manifest.lock` via create-if-absent)** — needs create-if-absent,
  which is also not universal, and adds lease/expiry complexity; rejected.
- **Immutable generation objects + LIST + fork detection** — needs only the
  universal S3 subset; chosen.

## Consequences

- Runs on **any** S3-compatible backend; no dependency on conditional writes.
- Yields **free manifest history** (immutable per-generation objects) → enables
  point-in-time recovery; old manifests are GC'd beyond a retention window.
- Costs one `LIST manifests/` per publish (cheap — the prefix holds few small
  objects when GC'd).
- **Eventual-consistency caveat:** a backend with eventually-consistent LIST may
  briefly hide a concurrent manifest; fork detection then occurs on the next sync
  and still converges with no data loss. Noted in the
  [threat model](../architecture/threat-model.md).

## Open question

Default manifest-history retention (how many generations to keep for recovery vs.
GC aggressiveness).
