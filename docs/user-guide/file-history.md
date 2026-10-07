# File history and compare

Syncrypt keeps earlier versions of the files it syncs, and lets you look at them
and at what a sync is about to change. Everything is decrypted and compared **on
your device**; the storage only ever holds ciphertext.

## What you can do

- **See what a bulk change would do before you confirm it.** When Syncrypt
  pauses for confirmation, each line that would overwrite or delete a file has a
  **Compare** button. It opens a read-only view of what is in the file now
  against what the sync would leave. Looking changes nothing, and the dialog
  stays open.
- **Look at a file's history.** Run **"File history (versions kept in storage)"**
  from the command palette, or use **Syncrypt: file history** in the file's
  context menu. You get the versions kept in storage with date and size.
- **See what changed.** On any earlier version: **Compare with this device**, or
  **What changed** (that version against the one that followed it).
- **Get a version back.** **Restore as copy** writes the version next to the
  file as `name (restored from 2026-10-05).md`. It never overwrites anything;
  copy what you need from it. The copy syncs like any new file.

## Reading the comparison

The two sides are labelled **Left** and **Right**. In the Safe-Sync dialog, left
is what is on this device now and right is what the sync would leave, so a line
marked `−` is a line that would be **lost**. Added lines are `+`, removed lines
`−`, with three lines of context; `@@ −12 +14 @@` gives the line numbers on each
side.

- Same text, different line endings, a missing final newline or a byte-order
  mark: the view says so instead of showing every line as changed.
- Not a text file (images, PDFs, anything with binary content) or larger than
  1 MB: no diff. You see the sizes and dates of both sides. Files over the limit
  are not downloaded just to say so.
- Two files that differ in more than about a thousand lines are called "largely
  different files" rather than listed.

## What is kept, and for how long

- Storage keeps the **current** version and up to **Versions to keep** earlier ones
  per file (default 3; Settings → Safe Sync). A deleted file's last versions are
  kept too, so you can restore a file that was deleted on every device.
- A version is stored when a changed file is **uploaded**. Edits you make and
  overwrite between two syncs on one device are not separate versions.
- Versions older than the depth are gone from storage (and become eligible for
  "Reclaim storage"). History is shared: any unlocked device sees it.
- Opening the history needs the storage to be reachable. Offline, you get an
  error and nothing else happens.

## What it does not do

It does not merge. When the same note was edited on two devices, Syncrypt still
keeps both as a conflicted copy; use the comparison to see the difference and
merge by hand. It does not restore in place, and it does not show versions older
than the depth above.
