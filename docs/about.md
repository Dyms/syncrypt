# About Syncrypt

*Русская версия: [docs/ru/about.md](./ru/about.md)*

## Why I built it

A few years of my notes live in Obsidian. One day, the sync system I trusted
mass-deleted and duplicated roughly a thousand of them. I got the notes back
from backups, but I lost something harder to restore: the confidence that I
understood what my sync tool was doing.

Syncrypt is my answer. It is built around one rule I refuse to compromise on:

> **A sync tool must never surprise you.**

Everything else follows from that rule.

## The philosophy

**Your files are the truth.** There is no hidden database, no revision tree,
no background magic. Your Markdown files, exactly as they are on disk, are the
canonical state. Syncrypt's only job is to move them — encrypted — between
your devices via storage you own.

**Sync is just upload and download.** A small, plain manifest (encrypted, like
everything else) records what the vault looked like after the last sync. Each
device compares three things — its files now, that manifest, and the other
devices' manifest — and the result is a list of uploads, downloads, and
conflicts. Nothing more exotic than that.

**When in doubt, stop and ask.** Two devices edited the same note? You get
both versions, clearly labeled — Syncrypt never picks a winner by discarding
bytes. A sync wants to delete or overwrite an unusually large number of files?
It pauses and shows you every single one first. A file fails to decrypt?
Nothing is applied. The failure modes are boring on purpose.

**You can always leave.** Your data sits in your bucket in a documented
format. With your passphrase, a short script using standard libraries restores
everything — no Syncrypt required. An exit door that actually works is the
only honest proof that "you own your data" isn't a slogan.

## Goals

- Keep one Obsidian vault identical across macOS, Windows, and Android.
- Client-side end-to-end encryption; storage sees only ciphertext.
- Work with storage you already own: any S3-compatible service or WebDAV.
- Make every action visible and explainable (sync log, dry-run).
- Be safe by default: local trash for deletions, version retention,
  confirmation before bulk changes.
- Stay small enough that one person can read and audit the whole thing.

## Non-goals

- **Real-time collaboration.** If you and someone else type into the same note
  simultaneously, you want a CRDT tool, not Syncrypt. For one person moving
  between devices, real-time machinery adds risk without adding value.
- **Automatic merging.** Syncrypt will never merge two versions of a note by
  itself. Merging is a judgment call, and judgment calls belong to you.
- **Hiding metadata perfectly.** Your storage provider can see object counts,
  sizes, and timing — not contents, not filenames. Hiding size patterns too
  would cost efficiency; I chose to state the limitation plainly instead
  ([details](./security.md)).
- **Being a backup.** Sync replicates your mistakes as faithfully as your
  edits. Keep a real backup; Syncrypt's safety rails make accidents
  recoverable, not impossible.

## Who it's for

People who keep years of thinking in plain-text notes and want them on every
device — without handing them, readable, to a cloud company, and without
trusting a tool they can't inspect. If that's you, welcome.
