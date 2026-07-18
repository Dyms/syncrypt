// Central path canonicalization — ADR-0007.
//
// Every path entering the manifest or the diff is canonical: NFC-normalized,
// POSIX-separated, relative, with no "." / ".." segments. Case-only collisions
// are detected and surfaced as conflicts, never silently deduplicated.

import { SyncError } from "./errors.js";
import type { VaultPath } from "./types.js";

/** Normalize a vault-relative path to canonical form. Throws on invalid input. */
export function canonicalizePath(input: string): VaultPath {
  const nfc = input.normalize("NFC").replaceAll("\\", "/");
  const segments = nfc.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) {
    throw new SyncError("VaultFileNotFound", `not a valid vault path: "${input}"`);
  }
  for (const s of segments) {
    if (s === "..") {
      throw new SyncError(
        "VaultFileNotFound",
        `path escapes the vault (".." segment): "${input}"`,
      );
    }
  }
  return segments.join("/");
}

/** True if the string is already in canonical form. */
export function isCanonicalPath(p: string): boolean {
  try {
    return canonicalizePath(p) === p;
  } catch {
    return false;
  }
}

/**
 * Group paths that collide case-insensitively (e.g. "Note.md" vs "note.md").
 * Returns only groups with 2+ members; the caller surfaces them as conflicts.
 */
export function detectCaseCollisions(paths: Iterable<VaultPath>): VaultPath[][] {
  const byFolded = new Map<string, VaultPath[]>();
  for (const p of paths) {
    const folded = p.toLowerCase();
    const group = byFolded.get(folded);
    if (group) group.push(p);
    else byFolded.set(folded, [p]);
  }
  const collisions: VaultPath[][] = [];
  for (const group of byFolded.values()) {
    if (group.length > 1) collisions.push([...group].sort());
  }
  return collisions.sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
}
