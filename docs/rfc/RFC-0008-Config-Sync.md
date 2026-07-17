# RFC-0008: Plugin & App Configuration Sync

- **Status:** Draft
- **Author(s):** Dmitriy (idea) · Architecture: Claude
- **Created:** 2026-07-16
- **Target:** post-1.0. Not part of the v1 scope (RFC-0002 non-goals).
- **Related:** RFC-0002 (Config category), RFC-0004, ADR-0010, ADR-0016

## Summary

A friendlier way to sync Obsidian **plugin/app configuration** across devices:
Syncrypt lists installed plugins and offers **per-plugin opt-in** toggles in
settings, which under the hood add/remove that plugin's data paths from the sync
profile's **Config** category. No sync-engine changes — this is profile-management
UX plus safety rails.

## Motivation

Users who run the same plugins on multiple machines want consistent settings
(snippets, community-plugin list, chosen plugin data). Today this is possible only
by hand-editing include/exclude globs (RFC-0002 category 2). This RFC makes it a
guided, safe toggle instead of a footgun.

## Design

- Enumerate installed plugins (`.obsidian/plugins/*/manifest.json`,
  `community-plugins.json`). Present a list with a per-plugin **Sync settings**
  toggle. Enabling a toggle adds `.obsidian/plugins/<id>/**` to the profile's
  Config includes; disabling removes it.
- Optionally sync a small, non-secret `installed-plugins` list so each device can
  show the **intersection** ("installed on both"). v1 of the feature may skip the
  intersection and just toggle from the local list.
- Config files are ordinary files to the engine: content-hashed, encrypted,
  conflict-surfaced like any other.

## Safety rails (non-negotiable for this feature)

1. **Other plugins' secrets.** Many plugins store API keys/tokens in their
   `data.json`. Enabling sync for such a plugin spreads secrets. Maintain a
   **denylist** of known secret-bearing plugins and show a prominent warning
   before enabling any plugin's config sync. (Syncrypt's own `data.json` stays
   hard-excluded — ADR-0016.)
2. **Device-specific values.** Paths, hotkeys, window state break when synced
   blindly. Per-plugin opt-in + a warning; recommend leaving device-specific
   files out.
3. **Conflict UX is worse than notes.** A conflict on `data.json` yields a
   `conflicted copy` file, which the plugin cannot read — it loses config until
   the user merges by hand. Document this; it is acceptable because settings
   change rarely and rarely simultaneously.
4. **Plugin version skew.** Different plugin versions may use different config
   schemas; syncing across versions can corrupt settings. Warn to keep versions
   aligned.

## Non-goals

- Merging plugin settings (no schema-aware merge — conflicts stay file-level).
- Syncing plugin *binaries/code* (only their config data, and only opt-in).

## Open questions

- Should the denylist ship built-in, be community-maintained, or both?
- Provide a "safe subset" preset (snippets + community-plugins.json + a few known-
  safe plugins) as a one-click default?

## Consequences

- Pure UX + profile layer; the durability-critical engine is untouched.
- Adds a settings surface and a maintained denylist to keep users safe.
