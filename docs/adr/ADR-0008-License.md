# ADR-0008: Project license

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

Syncrypt is intended to be a real, widely-usable open-source project (a shared
core with many editor plugins). The license affects adoption, contribution and
patent posture. The author prefers a short, permissive license.

## Decision

Adopt the **MIT License**.

## Options considered

- **MIT** — shortest and most permissive; maximal adoption; universally understood;
  trivial for plugin ecosystems and downstream reuse. No explicit patent grant
  (patent risk for a small sync/crypto utility using standard primitives is low).
  **Chosen.**
- **Apache-2.0** — permissive plus an explicit patent grant and NOTICE mechanism;
  slightly more ceremony and a longer header. A reasonable alternative if an
  explicit patent grant becomes desirable; switching MIT → Apache-2.0 later is
  low-friction.
- **GPL-3.0 / MPL-2.0** — copyleft; higher friction for plugin ecosystems and
  commercial downstream; not aligned with the "widely usable" goal.

## Consequences

- `/LICENSE` contains the MIT text; `license: "MIT"` is set in `package.json` and
  each package's manifest.
- Contributions are inbound=outbound under MIT (standard GitHub terms).
- If a patent grant is later wanted, re-evaluate via a superseding ADR.

## Note

Confirm the copyright holder line in `/LICENSE` (name/handle) before the first
public release.
