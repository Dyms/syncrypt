# Contributing to Syncrypt

Thanks for considering a contribution. Syncrypt is a specification-first project:
the documentation is the contract, and code implements it.

## Golden rules

1. **Design changes go through RFC/ADR, not straight into code.** If a PR changes
   *behavior or architecture*, it must reference (or add) the RFC/ADR that
   justifies it. See [`PROJECT.md`](./PROJECT.md) for the RFC vs ADR distinction.
2. **No magic.** Every sync action must be explainable in one sentence and must
   appear in the human-readable sync log. If you can't explain it simply, it
   doesn't ship.
3. **Data safety beats convenience.** When in doubt, stop and ask the user to
   `pull first` rather than guessing a merge.
4. **Zero telemetry.** No analytics, no crash phone-home, no "anonymous usage".

## Workflow

1. Open an issue describing the problem or proposal.
2. For anything architectural, submit an RFC (`docs/rfc/RFC-000N-*.md`) or an
   ADR (`docs/adr/ADR-000N-*.md`) using the templates. Discuss until `Accepted`.
3. Implement against the accepted spec. Reference the RFC/ADR in the PR.
4. Add tests. The core engine and providers must stay deterministic and covered.

## Commit / PR conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- One logical change per PR. Keep diffs reviewable.
- Update docs in the same PR as the behavior they describe.

## Working with AI coding agents

This repo is intentionally AI-friendly. If you use an agent (Claude Code, Codex,
etc.), point it at [`.ai/project.md`](./.ai/project.md) and the relevant RFC.
The agent must still follow the golden rules above; treat its output like any
other contributor's — reviewed, tested, and traceable to a decision.

## Code style

See [`.ai/coding-style.md`](./.ai/coding-style.md). TypeScript, strict mode,
no implicit `any`, pure functions in `core`, side effects at the edges.

## Local setup

The monorepo uses workspaces. Setup instructions will land with M1; until then
this repository is specification-only.
