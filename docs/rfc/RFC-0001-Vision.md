# RFC-0001: Vision

- **Status:** Accepted
- **Author(s):** Dmitriy (project author)
- **Created:** 2026-07-16
- **Related ADRs:** ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005

## Summary

Syncrypt is a small, explainable, end-to-end-encrypted synchronization engine
for Obsidian vaults across a single user's devices (macOS, Windows, Android),
using object storage the user already owns. It treats plain Markdown files as the
source of truth and reduces synchronization to two auditable operations —
**upload** and **download** — coordinated by a plain-JSON manifest.

## Mission

**Keep a personal Obsidian vault identical across all of the user's devices,
without ever silently losing or duplicating data, using storage the user owns and
mechanics the user can fully understand and repair by hand.**

## Vision

A world where "syncing my notes" does not mean trusting an opaque service or a
hidden database. Your notes are just files. Syncing them is just copying the
changed ones to a place you control, encrypted, with a written record of what
changed and why. If Syncrypt disappeared tomorrow, your data — and your ability
to access it — would be completely unaffected.

## The problem

The author previously used Self-hosted LiveSync. After an incident, ~1,000 notes
were partially deleted and partially duplicated, and had to be restored from
backup. LiveSync is not bad — it is built for **real-time, multi-device,
concurrent editing** on top of CouchDB with a revision tree and CRDT-style
replication. That machinery is powerful but:

- introduces a hidden database as a second source of truth;
- makes failure modes hard to reason about and hard to repair by hand;
- solves concurrency the user does not actually have.

The user's real requirements are far simpler (see RFC-0002). Solving a simpler
problem with simpler machinery is safer.

## Principles

These are load-bearing. Every design decision is checked against them.

> **Prime directive: Syncrypt should never surprise the user.**
> Everything below is a way of upholding this. If a design choice could produce a
> result the user did not expect and cannot explain, it is wrong — stop, surface,
> and let the user decide.

1. **Simple. Secure. Predictable.** In that order of tie-breaking.
2. **User owns the data.** Not Syncrypt, not the storage provider, not S3, not a
   database — the *user*. This implies: you can leave at any moment; data is
   always directly accessible; no vendor lock-in; no proprietary file format; no
   hidden database.
3. **No magic.** Every synchronization step must be explainable in a single
   sentence and must appear in a human-readable log — e.g. *"remote version is
   newer"*, *"local hash differs from manifest"*, *"file marked as deleted in
   manifest"*.
4. **Offline first.** Losing the network is a non-event. Work continues; sync
   happens when connectivity returns.
5. **Markdown first.** Plain files are the contract. The engine must never
   require a note to pass through a proprietary representation to be synced.
6. **Zero telemetry.** Syncrypt never phones home. No analytics, no crash
   reporting, no "anonymous usage".
7. **Fail loud, recover trivially.** Ambiguity stops the sync and asks the user;
   it never guesses a destructive merge.

## Design philosophy

- **Files over databases.** The filesystem *is* the database.
- **Explicit over implicit.** A manifest you can open and read beats inferred
  state.
- **Boring cryptography.** Use vetted primitives (AES-256-GCM, Argon2id), never
  invent our own.
- **A platform, not a plugin.** One reusable core + SDK, with two axes of
  extensibility: **storage providers** (S3 first; WebDAV, R2, OneDrive, local
  folder later) and **clients** (Obsidian first; later Logseq, VS Code, Foam,
  Zettlr, other Markdown editors, a headless CLI, and a Docker/self-hosted
  runner). The engine is agnostic to both the backend and the editor — a note is
  just a file. New backends and new clients slot in without redesigning the core.
- **Documentation as a contract.** Written to be usable by humans and AI coding
  agents alike, so implementation can proceed from the spec.

## Alternatives considered (how we got here)

Before deciding to build, these were weighed against the requirements (RFC-0002):

| Option | Verdict | Why |
|---|---|---|
| Self-hosted LiveSync | ★★★☆☆ | Powerful real-time CRDT sync, but stores a **database**, not files; complex (PouchDB/CouchDB/replication); painful recovery. Source of truth stops being Markdown. |
| Rhyolite Sync (`nogipx/rhyolite_sync`) | ★★★★☆ | File-based, Dropbox-like (md → S3 → download); no DB/replication/revision-tree — the right shape. But young, single-author, lightly tested. |
| Syncthing | ★★☆☆☆ | Great P2P file sync, but Mac sleeps and Android throttles background → not reliable for this device mix. |
| Git | ★★☆☆☆ | Loved for versioning, but poor for daily note-taking on a phone. |
| **Build a small custom sync over S3** | ★★★★★ | Simplest thing that meets every requirement; file-based; explainable; ~1–2k lines, not tens of thousands. **Chosen** → Syncrypt. |

Two viable paths emerged: adopt **Rhyolite Sync** ("set and forget") or **build**
a minimal, transparent plugin ("for years"). The build path was chosen because it
best fits a simple/transparent/predictable philosophy and gives full control over
the data-safety guard rails (ADR-0010) that the motivating incident showed are
essential. Syncrypt then generalized from "an Obsidian S3 plugin" into a storage-
and editor-agnostic platform.

## Scope

**In scope (v1):** one user, one logical vault; macOS + Windows + Android;
S3-compatible storage; client-side encryption; open/close/manual **and**
resource-aware while-active sync; explicit conflict surfacing. The **Obsidian
plugin** is the first client, built on a storage- and editor-agnostic core so
other clients can follow.

**Out of scope (v1):** real-time sync; multi-user concurrent editing; automatic
conflict merging; mandatory self-hosted server components; proprietary formats.
See RFC-0002 for the full non-goals list.

## What success looks like

- The three-device loop (Windows ↔ macOS ↔ Android) converges reliably.
- No incident of silent data loss or duplication across a long fuzz/property test
  suite and real usage.
- A technical user can, at any time, open the manifest, understand the current
  state, and restore any file from storage by hand.
- The storage backend never holds anything but ciphertext.

## Unresolved questions

- How much metadata confidentiality (file paths, sizes) do we trade for
  usability and debuggability? Explored in RFC-0005.
- Final license (ADR-0008) and naming positioning (ADR-0009).
