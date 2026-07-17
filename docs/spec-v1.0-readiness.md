# spec-v1.0 readiness (M6 audit, 2026-07-17)

Status of everything the `spec-v1.0` tag certifies. Audited at M6 completion;
all gates below are green in CI (`typecheck`, `lint`, 190+ tests incl. live
MinIO + live WebDAV suites, plugin build with the mobile guard).

## Verified ✅

- **RFCs 0001–0007:** all `Accepted`; erratum recorded where implementation
  corrected the spec (RFC-0006/ADR-0006 fork-prevention wording); resolved
  questions annotated in place (RFC-0005 KDF params + object keys; RFC-0007
  state persistence).
- **ADRs 0001–0018:** every ADR is `Accepted` (0000 is the template). Each
  code-relevant ADR is cited in package sources (audited by grep):
  0002/0003 ×2, 0006 ×15, 0007 ×8, 0010 ×13, 0011 ×6, 0012 ×4, 0013 ×4,
  0014 ×5, 0015 ×4, 0016 ×5, 0017 ×2, 0018 ×7. Non-code decisions
  (0001, 0004, 0005, 0008, 0009) are reflected in the docs they govern.
- **Both invariant-critical proofs:**
  - no-loss / no-silent-overwrite: planner property tests + fuzzed two-device
    convergence (memory, real dirs, live S3, live WebDAV);
  - ciphertext-only storage asserted on every e2e backend;
  - manifest concurrency correct with `conditionalWrites=false` (WebDAV e2e).
- **Hand-recovery guarantee:** `recover.mjs` exercised in CI against real
  encrypted output; Python variant verified against real output.
- **CHANGELOG:** M1–M6 sections complete. **ROADMAP:** M1–M3, M6 ✅;
  M4/M5 ◐ (code complete, field validation pending — see below).

## Remaining for YOU before cutting `spec-v1.0` 🔲

1. **M4 field sign-off:** the two-desktop (macOS + Windows) daily-use loop
   from the M4 checklist, on the current build (requestUrl transport).
2. **M5 field sign-off:** the Android on-device checklist
   ([android-validation.md](./developer-guide/android-validation.md)),
   including the negative case (desktop-only vault refused).
3. Optional but recommended: one conformance run against **your own S3
   endpoint** (`SYNCRYPT_S3_TEST_ENDPOINT=…` + keys) — vendors differ.
4. Flip ROADMAP M4/M5 to ☑ with the sign-off notes (device models, timings).
5. Tag: `git tag -a spec-v1.0 -m "…" && git push --tags` (per PROJECT.md the
   spec version is tagged separately from package versions).

## Explicitly OUT of spec-v1.0 (tracked, not blockers)

- npm publishing: package `exports` point at `src/*.ts` (works in-monorepo);
  a dist build + publishConfig is needed before publishing `@syncrypt/*`.
- Tombstone/orphan GC, `manifest.json` latest-pointer, streaming large files,
  optional size padding — post-1.0 per the RFCs' open questions.
- Keyfile authentication (beyond ADR-0014 bounds) — deferred hardening noted
  in ADR-0014.
