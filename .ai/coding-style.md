# Coding Style

- **Language:** TypeScript, `strict: true`, no implicit `any`, no non-null `!`
  unless justified.
- **Purity:** `core` is pure and deterministic. All I/O, randomness, time, and
  crypto side effects go through injected ports. This is what makes the planner
  testable and portable to Android.
- **No Node-only APIs in `core`/`sdk`.** Use WebCrypto and injected abstractions.
- **Errors:** typed, normalized (see RFC-0006 error contract). Fail closed.
- **Naming:** explicit over clever. A reader should map code to RFC/ADR terms
  (manifest, generation, tombstone, plan, port).
- **Tests:** planner via golden fixtures + property-based tests asserting the
  invariants (no loss, no silent overwrite). Providers via the shared conformance
  suite.
- **Logging:** the sync log is a product surface — one human-readable reason per
  action; never log secrets.
- **Commits:** Conventional Commits; one logical change per PR; docs updated with
  behavior.
