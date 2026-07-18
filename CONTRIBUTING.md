# Contributing to Syncrypt

Thanks for considering a contribution. A few principles keep this project what
it is:

1. **No surprises.** Every sync action must be explainable in one sentence and
   appear in the human-readable sync log. If you can't explain it simply, it
   doesn't ship.
2. **Data safety beats convenience.** When in doubt, stop and ask the user
   rather than guessing.
3. **Zero telemetry.** No analytics, no crash phone-home, no "anonymous usage".
4. **Boring cryptography.** Vetted primitives and implementations only; never
   anything invented here.

## How to contribute

- **Bug reports** are the most valuable contribution: exact steps, what you
  expected, what happened, and the relevant lines from the sync log. For
  anything security-related, use [SECURITY.md](./SECURITY.md) instead of a
  public issue.
- **Feature ideas**: open an issue describing the *problem* first. Behavior
  and architecture changes get discussed before code — expect design
  questions; sync tools earn trust slowly.
- **Pull requests**: open an issue first for anything non-trivial. Keep one
  logical change per PR, add tests (the engine and providers are heavily
  test-covered — new behavior needs the same), and update docs in the same PR.

## Practicalities

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- TypeScript strict mode; the core engine is pure (no I/O) with effects at the
  edges; no Node-only APIs in code the mobile plugin ships.
- `npm install && npm test` runs everything, including live-backend suites
  against an in-process WebDAV server; S3 suites additionally run when you
  point `SYNCRYPT_S3_TEST_ENDPOINT` at a MinIO (CI does this automatically).
- `npm run lint`, `npm run typecheck`, `npm run build` must stay green.
