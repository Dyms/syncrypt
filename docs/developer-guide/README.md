# Developer Guide

How to build, test, and extend Syncrypt. Populated as implementation lands (M1+).

Planned contents:
- Local setup & monorepo workflow
- Writing a new **StorageProvider** (implement `StoragePort`, pass the conformance suite) — see [RFC-0006](../rfc/RFC-0006-Storage-Provider-API.md)
- Writing a new **client** (implement `VaultPort`) — Obsidian, Logseq, VS Code, CLI…
- Testing strategy (planner golden fixtures + property tests; provider conformance)
- Release process & versioning
- Developer onboarding
