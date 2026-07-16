# @syncrypt/obsidian

The Obsidian client (desktop + mobile). Implements VaultPort via the Obsidian API,
provides settings, sync triggers (on open/close, manual "Sync now"), and renders
the human-readable sync log. Must respect Obsidian mobile constraints (no Node
APIs; no background daemon — see the
[compatibility matrix](../../docs/architecture/overview.md#compatibility-matrix)).

Status: not yet implemented — see [ROADMAP M4/M5](../../ROADMAP.md).
