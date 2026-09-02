// Storage reclamation — the pure half (ADR-0030).
//
// Deleting a storage object is the ONE thing this project does that nothing
// undoes: a trashed file is in the trash, a forgotten entry comes back from the
// device that carries it, a lost conflict resolution is a copy on disk. So the
// arithmetic that decides what is garbage lives here, with no I/O anywhere near
// it, and is tested on its own.
//
// The rule is mark → wait → sweep. "Unreferenced and old" is NOT safe: the
// deduplication probe in applyPushOps skips uploading content that is already
// stored, so an old unreferenced object can be adopted by a push that is in
// flight right now. What bounds that window is the duration of one push, not
// the object's age — hence a grace period measured from when the object was
// FIRST SEEN unreachable, plus a re-check at sweep time.

import { SyncError } from "./errors.js";
import type { Manifest, ObjectKey } from "./types.js";

/** Content objects live here and nothing else is ever a GC candidate. */
export const OBJECTS_PREFIX = "objects/";

/** Where the pending mark is kept (encrypted with the manifest key). */
export const GC_MARK_KEY: ObjectKey = "meta/gc-mark.json";

/**
 * How many keys the mark may carry.
 *
 * The mark is the only thing in this design with no natural ceiling: a vault
 * that has churned for years can have tens of thousands of unreachable
 * objects, and each one costs a key and a timestamp in an object that is
 * re-uploaded on every run. Past the cap the OLDEST-marked keys are kept —
 * they are the ones closest to being collectable — and the rest simply wait
 * for a later run. Nothing is lost by forgetting a mark entry: the object is
 * still unreachable next time and gets marked again, one grace window later.
 */
export const MAX_MARKED_KEYS = 20_000;

/**
 * Object keys seen unreachable, and when they were FIRST seen that way.
 * Persisted so that running the command twice in a minute does not restart
 * everybody's clock.
 */
export interface GcMark {
  version: 1;
  updatedAt: number; // epoch seconds
  unreachableSince: Record<ObjectKey, number>; // epoch seconds
}

/**
 * One manifest object in storage, with the generation its key encodes.
 *
 * `manifest` is loaded ONLY for the retained generations. A vault that has
 * synced for a month has thousands of generations, and a manifest for a
 * three-thousand-file vault is most of a megabyte — fetching and decrypting
 * all of them to learn which keys to delete would move gigabytes to answer a
 * question about a handful of them. Generations below the cut are pruned by
 * their key alone; nothing about their contents matters.
 */
export interface ManifestInStorage {
  key: ObjectKey;
  generation: number;
  manifest?: Manifest;
}

export interface ReclaimPlan {
  /** Deletable NOW: marked long enough ago and still unreachable. */
  sweep: ObjectKey[];
  sweepBytes: number;
  /** Unreachable, but not yet ripe — including anything marked by this run. */
  waiting: number;
  waitingBytes: number;
  /** Epoch seconds at which the oldest waiting object ripens; null if none. */
  ripeAt: number | null;
  /** Manifest objects below the retention cut. Pruned without a grace. */
  prunedManifests: ObjectKey[];
  /** The mark to persist after acting on this plan. */
  nextMark: GcMark;
  /** Highest generation in storage; 0 when the vault has no manifest. */
  generation: number;
}

/**
 * Every object key any retained manifest still points at — live entries and
 * retained prior versions alike (ADR-0010 §3).
 */
export function reachableObjectKeys(manifests: readonly Manifest[]): Set<ObjectKey> {
  const reachable = new Set<ObjectKey>();
  for (const m of manifests) {
    for (const entry of Object.values(m.files)) reachable.add(entry.objectKey);
    for (const versions of Object.values(m.history ?? {})) {
      for (const entry of versions) reachable.add(entry.objectKey);
    }
  }
  return reachable;
}

/**
 * The newest `keep` GENERATIONS — not the newest `keep` manifests. A fork
 * (ADR-0006 §4) leaves two manifests at one generation, and the loser's objects
 * must stay alive until it has re-planned; keeping generations rather than
 * objects is what guarantees that.
 */
export function retainedGenerations(
  generations: readonly number[],
  keep: number,
): Set<number> {
  const distinct = [...new Set(generations)].sort((a, b) => b - a);
  return new Set(distinct.slice(0, Math.max(1, keep)));
}

export interface ReclaimInput {
  now: number; // epoch seconds
  graceSeconds: number;
  generationsToKeep: number;
  /** Every manifest object found under manifests/. */
  manifests: readonly ManifestInStorage[];
  /** Every object found under objects/ — nothing else is ever a candidate. */
  objects: readonly { key: ObjectKey; size: number }[];
  /** The mark as last persisted, or null when there is none. */
  mark: GcMark | null;
}

/**
 * Decide what may go. Deterministic and total: same inputs, same answer, no
 * clock of its own, no I/O.
 */
export function planReclaim(input: ReclaimInput): ReclaimPlan {
  const { now, graceSeconds, manifests, objects, mark } = input;

  // Fail CLOSED before anything else. "No manifests, but objects" is not a
  // vault state the protocol can produce: a bucket holding ciphertext holds
  // the manifest that references it. It is what an under-reporting LIST looks
  // like — an eventually-consistent listing, a dropped pagination cursor, a
  // provider blind on one prefix (the WebDAV base-path defect was exactly
  // this, ADR-0039) — and taken at face value it makes EVERY object
  // unreachable, which is the whole vault (ADR-0041).
  if (manifests.length === 0 && objects.length > 0) {
    throw new SyncError(
      "ManifestCorrupt",
      `refusing to reclaim: storage lists ${String(objects.length)} objects and no manifest at all`,
    );
  }

  const retained = retainedGenerations(
    manifests.map((m) => m.generation),
    input.generationsToKeep,
  );
  const prunedManifests = manifests
    .filter((m) => !retained.has(m.generation))
    .map((m) => m.key)
    .sort();
  // Fail CLOSED. A retained manifest that was not loaded would make everything
  // it references look unreachable — the exact shape of a mass deletion.
  const retainedManifests: Manifest[] = [];
  for (const m of manifests) {
    if (!retained.has(m.generation)) continue;
    if (m.manifest === undefined) {
      throw new SyncError(
        "ManifestCorrupt",
        `refusing to reclaim: manifest for retained generation ${String(m.generation)} was not loaded`,
      );
    }
    retainedManifests.push(m.manifest);
  }
  const reachable = reachableObjectKeys(retainedManifests);

  const previous = mark?.unreachableSince ?? {};
  const unreachableSince: Record<ObjectKey, number> = {};
  const sweep: ObjectKey[] = [];
  let sweepBytes = 0;
  let waiting = 0;
  let waitingBytes = 0;
  let ripeAt: number | null = null;

  for (const object of objects) {
    // Structural, not a policy: manifests are pruned by the generation rule
    // above and meta/ holds the KDF salt every device needs. Only objects/.
    if (!object.key.startsWith(OBJECTS_PREFIX)) continue;
    if (reachable.has(object.key)) continue;

    // An object already in the mark keeps its ORIGINAL timestamp — otherwise
    // running the command often would mean nothing ever ripens.
    const since = Math.min(previous[object.key] ?? now, now);
    unreachableSince[object.key] = since;

    if (since + graceSeconds <= now) {
      sweep.push(object.key);
      sweepBytes += object.size;
    } else {
      waiting++;
      waitingBytes += object.size;
      const ripe = since + graceSeconds;
      ripeAt = ripeAt === null ? ripe : Math.min(ripeAt, ripe);
    }
  }

  sweep.sort();
  return {
    sweep,
    sweepBytes,
    waiting,
    waitingBytes,
    ripeAt,
    prunedManifests,
    nextMark: { version: 1, updatedAt: now, unreachableSince: capMark(unreachableSince) },
    generation: manifests.reduce((max, m) => Math.max(max, m.generation), 0),
  };
}

/**
 * Keep the oldest-marked keys and drop the rest (see MAX_MARKED_KEYS). Ties
 * break on the key so the result is deterministic — two devices computing the
 * same mark must agree, or they would fight over its contents every run.
 */
function capMark(since: Record<ObjectKey, number>): Record<ObjectKey, number> {
  const entries = Object.entries(since);
  if (entries.length <= MAX_MARKED_KEYS) return since;
  entries.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(entries.slice(0, MAX_MARKED_KEYS));
}

/** The mark to persist once `plan.sweep` has actually been deleted. */
export function markAfterSweep(plan: ReclaimPlan): GcMark {
  const unreachableSince = { ...plan.nextMark.unreachableSince };
  for (const key of plan.sweep) delete unreachableSince[key];
  return { ...plan.nextMark, unreachableSince };
}
