# ADR-0009: Name "Syncrypt" and positioning

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

The name **Syncrypt** = *sync* + *crypt*: encrypted sync. It is short, memorable,
and matches the concept. However, an unrelated, now-defunct Python project named
"syncrypt" existed historically (published on PyPI). We should avoid user confusion
and namespace collisions.

## Decision

Keep the name **Syncrypt** for the project, but:

- On package registries, use a **scoped/namespaced** identifier to avoid clashes,
  e.g. npm scope `@syncrypt/*` (this repo) rather than an unscoped `syncrypt`.
- In README/docs, include a one-line disambiguation from the old Python project
  (already in README "A note on the name").
- Reserve the GitHub org/repo and npm scope early.

## Options considered

- **Rename** to something wholly unique — avoids all confusion but loses a good,
  on-concept name; not warranted given the old project is defunct.
- **Keep + namespace + disambiguate** — chosen.

## Consequences

- Slightly more care in branding and registry naming.
- Name **confirmed: Syncrypt**. GitHub repo already reserved at `Dyms/syncrypt`.
- npm scope **`@syncrypt` reserved** (org `syncrypt`, owner `dsbogatov`).
- GitHub repo reserved at `Dyms/syncrypt`.
