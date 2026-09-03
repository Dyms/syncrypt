// Local scanner + change detection — RFC-0004 §Change detection.
//
// The scan produces (path, hash, size, mtime) for every file the vault lists.
// Hash is authoritative; the (size, mtime) pair is only a cache key to avoid
// re-hashing unchanged files. The cache survives restarts (ADR-0023) — the
// engine persists it through StateStorePort — so reopening the app does not
// re-read and re-hash the whole vault.

import type { CryptoPort, VaultPort } from "./ports.js";
import { canonicalizePath } from "./paths.js";
import type { FileDescriptor, Hash, Manifest, VaultPath } from "./types.js";

/** What `path` hashed to when it last had exactly this size and mtime. */
export interface HashCacheEntry {
  size: number;
  mtime: number; // epoch seconds, sub-second precision where the platform has it
  hash: Hash;
}

/**
 * Incremental hash cache, one entry per path.
 *
 * A miss costs a re-hash, never correctness: the entry is used only when BOTH
 * size and mtime still match what the vault reports right now.
 */
export type HashCache = Map<VaultPath, HashCacheEntry>;

/**
 * Scan the vault into a deterministic (path-sorted) list of descriptors.
 * Files that disappear between list() and stat() are skipped (a scan is always
 * a snapshot attempt, never an error source).
 *
 * `ambiguous`, when given, collects paths that TWO listed files canonicalize
 * to. Those are left out of the result and are the caller's to exclude from
 * the plan — see the note at the collision check below.
 */
export async function scanVault(
  vault: VaultPort,
  crypto: CryptoPort,
  cache?: HashCache,
  signal?: AbortSignal,
  ambiguous?: Set<VaultPath>,
): Promise<FileDescriptor[]> {
  const found = new Map<VaultPath, FileDescriptor>();
  const collided = new Set<VaultPath>();
  const seen = new Set<VaultPath>();
  for await (const listed of vault.list()) {
    if (signal?.aborted) break;
    const path = canonicalizePath(listed);
    // Two files of this vault, one manifest key. Canonicalization is not
    // injective — "café.md" composed and decomposed are one path afterwards
    // (ADR-0007) — and the manifest has room for one of them. Taking either
    // is a coin toss the user never sees: the loser is never uploaded, and
    // each scan can pick the other one, so its hash flips and every sync
    // re-uploads the same key with different content.
    //
    // So neither is synced, and the caller is told. They are NOT reported as
    // absent, which would read as a local deletion and tombstone the entry
    // for every other device — the engine excludes them the way it excludes
    // paths outside this device's profile (ADR-0022).
    if (found.has(path) || collided.has(path)) {
      collided.add(path);
      found.delete(path);
      seen.add(path);
      continue;
    }
    const stat = await vault.stat(path);
    if (stat === null) continue; // vanished mid-scan
    seen.add(path);
    const cached = cache?.get(path);
    let hash =
      cached?.size === stat.size && cached.mtime === stat.mtime ? cached.hash : undefined;
    if (hash === undefined) {
      const data = await vault.read(path);
      hash = await crypto.hash(data);
      cache?.set(path, { size: stat.size, mtime: stat.mtime, hash });
    }
    found.set(path, { path, hash, size: stat.size, mtime: stat.mtime });
  }
  for (const path of collided) ambiguous?.add(path);
  // Only a COMPLETE scan knows which paths are gone. An aborted scan saw a
  // prefix of the vault, so pruning there would evict live entries and cost a
  // full re-hash next run.
  if (cache !== undefined && signal?.aborted !== true) {
    for (const path of cache.keys()) {
      if (!seen.has(path)) cache.delete(path);
    }
  }
  const out = [...found.values()];
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Persistence (ADR-0023) — the engine stores this inside its state blob.
// ---------------------------------------------------------------------------

/** One persisted row: [path, size, mtime, hash]. Compact on purpose. */
export type HashCacheRow = [VaultPath, number, number, Hash];

/** Wire form of the persisted cache. Versioned independently of the state blob. */
export interface EncodedHashCache {
  version: 1;
  entries: HashCacheRow[];
}

/**
 * How fresh an mtime has to be before we refuse to remember its hash.
 *
 * A write that lands in the same timestamp tick as our read is invisible to a
 * (size, mtime) key — same size, same mtime, different bytes. Within one
 * session that window is a few milliseconds and self-correcting; persisted, a
 * stale hash would outlive the restart that should have caught it. So an entry
 * whose mtime is not strictly older than this window is simply not written
 * out. It costs a re-hash of whatever the user just touched. (This is git's
 * "racily clean" rule, and the reason it exists.)
 */
export const RACY_WINDOW_SECONDS = 1;

/**
 * Encode for persistence, dropping entries too freshly modified to trust.
 * `now` is epoch seconds — the same clock the vault's mtimes come from.
 */
export function encodeHashCache(cache: HashCache, now: number): EncodedHashCache {
  const entries: HashCacheRow[] = [];
  for (const [path, e] of cache) {
    if (e.mtime + RACY_WINDOW_SECONDS > now) continue;
    entries.push([path, e.size, e.mtime, e.hash]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { version: 1, entries };
}

/**
 * Decode a persisted cache. NEVER throws and never rejects the whole blob for
 * one bad row: this is a cache, so anything unreadable simply is not cached.
 */
export function decodeHashCache(raw: unknown): HashCache {
  const cache: HashCache = new Map();
  if (typeof raw !== "object" || raw === null) return cache;
  const { version, entries } = raw as { version?: unknown; entries?: unknown };
  if (version !== 1 || !Array.isArray(entries)) return cache;
  for (const row of entries as unknown[]) {
    if (!Array.isArray(row) || row.length !== 4) continue;
    const [path, size, mtime, hash] = row as unknown[];
    if (typeof path !== "string" || path === "") continue;
    if (typeof hash !== "string" || hash === "") continue;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) continue;
    cache.set(canonicalizePath(path), { size, mtime, hash });
  }
  return cache;
}

export interface LocalChanges {
  added: VaultPath[];
  modified: VaultPath[];
  deleted: VaultPath[];
}

/**
 * Compare a scan against the base manifest (RFC-0004):
 * present locally, absent in base → added; in both, hash differs → modified;
 * in base, absent locally → deleted (candidate tombstone).
 */
export function detectLocalChanges(
  local: FileDescriptor[],
  base: Manifest | null,
  /** Paths this device's profile does not cover are never "deleted" (ADR-0022). */
  syncable: (path: VaultPath) => boolean = () => true,
): LocalChanges {
  const changes: LocalChanges = { added: [], modified: [], deleted: [] };
  const baseFiles = base?.files ?? {};
  const seen = new Set<VaultPath>();
  for (const f of local) {
    seen.add(f.path);
    const baseEntry = baseFiles[f.path];
    if (baseEntry === undefined) changes.added.push(f.path);
    else if (baseEntry.hash !== f.hash) changes.modified.push(f.path);
  }
  for (const path of Object.keys(baseFiles)) {
    if (!seen.has(path) && syncable(path)) changes.deleted.push(path);
  }
  changes.deleted.sort();
  return changes;
}
