# UI / UX Documentation

Guiding rule: **Syncrypt should never surprise the user** — the UI must always
make the current state and the reason for every action visible and
understandable. Implemented in the Obsidian client (M4).

## Surfaces

### Status bar
`Syncrypt: locked | unlocking… | idle | syncing… | synced N changes |
conflicts: N | waiting for confirmation | error`. Always present; one glance
answers "what is sync doing right now".

### Unlock flow (ADR-0016)
A modal asks for the passphrase on startup (once storage is configured) or via
the **Unlock** command. The passphrase is never stored; keys live in memory
until Obsidian quits or the **Lock** command runs. A wrong passphrase surfaces
as a fail-closed error notice — nothing is applied.

### Settings tab
Storage (endpoint/region/bucket/prefix/credentials/path-style) with the
ADR-0016 warning inline next to the credential fields; sync profile
(include/exclude globs, one per line); Safe Sync knobs (ADR-0010/0013 floor,
cap, fraction, versions to keep); auto-sync toggles (debounce, minimum
interval); the device ID.

### Sync log view (command: "Show sync log")
One line per applied file: `HH:MM:SS  path: <ReasonCode message>` — the
RFC-0007 §5 vocabulary verbatim, newest first. Warnings in red. No secrets,
ever: the engine logs reasons, not internals.

### Safe Sync confirmation (ADR-0010 §4)
When the circuit breaker fires, a modal shows the `confirmationReason` and
EVERY affected file with what would happen ("delete locally (to trash)",
"overwrite local file", "delete remotely (tombstone)"). Apply calls
`confirmAndApply`; Cancel (or just closing the modal) applies nothing.

### Conflicts (ADR-0012)
A notice reports "N conflict(s) — both versions kept"; the log names the
files. The remote version appears alongside as
`name (conflicted copy from <device> <date>).md` — resolve by merging or
deleting one copy, then sync again.

## Trigger model (RFC-0004)
Pull on layout-ready (after unlock) → debounced sync while editing (15 s
quiet, ≥ 30 s apart) → best-effort push on quit → manual **Sync now** any time
(bypasses the guards).
