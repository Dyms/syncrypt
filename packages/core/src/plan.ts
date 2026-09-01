// The pure planner — RFC-0004 §The diff / planner, RFC-0007 §3, ADR-0010/0012.
//
// plan() is a deterministic function of (local, base, remote, opts). It never
// performs I/O. The one rule above all: NEVER produce a silent overwrite —
// when both sides changed differently, the op is a conflict.

import { ReasonCode } from "./reasons.js";
import type { DeviceId, FileDescriptor, Hash, Manifest, VaultPath } from "./types.js";

export type OperationKind =
  | "upload" // local → storage
  | "download" // storage → local
  | "delete-local" // apply a remote deletion locally (via trash, ADR-0010)
  | "delete-remote" // propagate a local deletion (tombstone)
  | "conflict" // both sides changed differently — never auto-merged
  | "noop";

export interface Operation {
  kind: OperationKind;
  path: VaultPath;
  reason: ReasonCode; // the "no magic" explanation (RFC-0007 §5)
  localHash?: Hash;
  remoteHash?: Hash;
  baseHash?: Hash;
}

/**
 * Why a plan wants a human to look at it before anything is applied — as
 * numbers, not a sentence, so the client can phrase it (ADR-0026).
 */
export interface ConfirmationReason {
  code: "bulk-change";
  /** Operations that would destroy or replace existing local bytes. */
  destructive: number;
  /** Files scanned locally, for the "N of M" the user actually needs. */
  total: number;
}

/**
 * Why the breaker did NOT fire on a plan that, counted the old way, would have
 * (ADR-0029). Present only in that case, so a client can say so and stay quiet
 * the rest of the time.
 */
export interface PacingDiscount {
  /** Destructive ops in the plan, counted the way beta.8 counted them. */
  destructive: number;
  /** What the breaker actually judged: unpaced ops + the largest burst. */
  effective: number;
  /** Local deletions whose tombstones carried a time and a device. */
  paced: number;
  /** Seconds between the earliest and the latest of those deletions. */
  spanSeconds: number;
}

export interface SyncPlan {
  /** Ordered operations. Deterministic function of (local, base, remote). */
  operations: Operation[];
  /** Set when the divergence guard fires — a push must pull first (FR-8). */
  pullFirst: boolean;
  /** Set by the Safe-Sync circuit breaker (ADR-0010) — needs confirmation. */
  requiresConfirmation: boolean;
  /** Why confirmation is required (e.g. "would delete 42 files"). */
  confirmationReason?: ConfirmationReason;
  /** Set when deletion pacing kept the breaker quiet (ADR-0029). */
  pacingDiscount?: PacingDiscount;
  /** Convenience counts for UI. */
  summary: {
    uploads: number;
    downloads: number;
    deletions: number;
    conflicts: number;
  };
}

export interface PlanOptions {
  /** Safe-Sync bulk-change thresholds (ADR-0010 + ADR-0013 floor). */
  bulkChangeFloor: number; // default 5 — at or below: never prompt (routine)
  bulkChangeMaxFiles: number; // default 20 — at or above: always prompt
  bulkChangeMaxFraction: number; // default 0.10 — in between: prompt if ≥ 10% of vault
  /**
   * Seconds within which deletions from ONE device count as one burst
   * (ADR-0029). Deletions spread wider than this are the pace of a person
   * working, and the breaker does not count them all against itself.
   */
  deletionBurstWindow: number; // default 300
  /**
   * Does this device's profile cover the path (ADR-0022)? Paths that answer
   * false are skipped entirely: not downloaded here, and — crucially — never
   * mistaken for a local deletion just because this device does not list them.
   * Defaults to "everything".
   */
  syncable?: (path: VaultPath) => boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  bulkChangeFloor: 5,
  bulkChangeMaxFiles: 20,
  bulkChangeMaxFraction: 0.1,
  deletionBurstWindow: 300,
};

/**
 * The largest number of deletions from ONE device inside one window of
 * `windowSeconds` (ADR-0029). Per device on purpose: two people tidying at once
 * are two people, and a device's own clock skew cancels within its own group
 * instead of inflating somebody else's burst.
 */
export function peakBurst(
  deletions: readonly { at: number; device: DeviceId }[],
  windowSeconds: number,
): number {
  const byDevice = new Map<DeviceId, number[]>();
  for (const d of deletions) {
    const list = byDevice.get(d.device);
    if (list === undefined) byDevice.set(d.device, [d.at]);
    else list.push(d.at);
  }
  let peak = 0;
  for (const times of byDevice.values()) {
    times.sort((a, b) => a - b);
    let start = 0;
    for (let end = 0; end < times.length; end++) {
      // `times` is sorted and both indices are in range; the non-null
      // assertions are the price of noUncheckedIndexedAccess.
      while ((times[end] ?? 0) - (times[start] ?? 0) > windowSeconds) start++;
      peak = Math.max(peak, end - start + 1);
    }
  }
  return peak;
}

function span(deletions: readonly { at: number }[]): number {
  if (deletions.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of deletions) {
    lo = Math.min(lo, d.at);
    hi = Math.max(hi, d.at);
  }
  return hi - lo;
}

/** Per-path view of one side of the three-way diff. */
type SideState =
  | { kind: "absent" }
  | { kind: "live"; hash: Hash }
  | { kind: "tombstone" };

const ABSENT: SideState = { kind: "absent" };
const TOMBSTONE: SideState = { kind: "tombstone" };

function manifestState(m: Manifest | null, path: VaultPath): SideState {
  if (m === null) return ABSENT;
  const entry = m.files[path];
  if (entry !== undefined) return { kind: "live", hash: entry.hash };
  if (path in m.tombstones) return TOMBSTONE;
  return ABSENT;
}

function hashOf(s: SideState): Hash | undefined {
  return s.kind === "live" ? s.hash : undefined;
}

/**
 * Classify one path per the RFC-0004 decision table (absence = ⌀, tombstone = †).
 * Base tombstones behave like absence for comparison ("recreated = new file");
 * remote tombstones propagate deletion only onto an UNCHANGED local file.
 * Edit-vs-delete always conflicts (edit survives) — ADR-0012.
 */
function classify(
  path: VaultPath,
  local: SideState,
  base: SideState,
  remote: SideState,
): Operation | null {
  const op = (kind: OperationKind, reason: ReasonCode): Operation => {
    const o: Operation = { kind, path, reason };
    const l = hashOf(local);
    const b = hashOf(base);
    const r = hashOf(remote);
    if (l !== undefined) o.localHash = l;
    if (b !== undefined) o.baseHash = b;
    if (r !== undefined) o.remoteHash = r;
    return o;
  };

  if (local.kind !== "live") {
    // ⌀ locally.
    if (remote.kind !== "live") return null; // ⌀/†,*,⌀/† → nothing exists anywhere
    if (base.kind !== "live") {
      return op("download", ReasonCode.NewRemoteFile); // ⌀,⌀/†,B → new remote file
    }
    if (remote.hash === base.hash) {
      return op("delete-remote", ReasonCode.DeletedLocally); // ⌀,A,A → deleted locally
    }
    return op("conflict", ReasonCode.ConflictEditDelete); // ⌀,A,B → deleted vs edited
  }

  // Local live.
  if (remote.kind === "live") {
    if (local.hash === remote.hash) return null; // same content both sides
    if (base.kind === "live") {
      const localChanged = local.hash !== base.hash;
      const remoteChanged = remote.hash !== base.hash;
      if (localChanged && remoteChanged) {
        return op("conflict", ReasonCode.ConflictBothChanged); // B,A,C
      }
      if (localChanged) return op("upload", ReasonCode.LocalChanged); // B,A,A
      return op("download", ReasonCode.RemoteNewer); // A,A,B
    }
    return op("conflict", ReasonCode.ConflictSamePath); // B,⌀/†,C → independent create
  }

  if (remote.kind === "tombstone") {
    if (base.kind === "live") {
      if (local.hash === base.hash) {
        return op("delete-local", ReasonCode.DeletedRemotely); // A,A,†
      }
      return op("conflict", ReasonCode.ConflictEditDelete); // B,A,† → edit vs delete
    }
    if (base.kind === "tombstone") {
      return op("upload", ReasonCode.NewLocalFile); // B,†,† → recreated after deletion
    }
    // B,⌀,† — file we never synced vs a remote deletion: never discard unsynced
    // local bytes; surface it (revive-on-push per ADR-0012).
    return op("conflict", ReasonCode.ConflictEditDelete);
  }

  // Remote absent.
  if (base.kind === "live" && local.hash === base.hash) {
    // A,A,⌀ — anomalous (deletions must be tombstones, RFC-0004); re-add, never drop.
    return op("upload", ReasonCode.NewLocalFile);
  }
  if (base.kind === "live") {
    return op("upload", ReasonCode.LocalChanged); // B,A,⌀ — changed + remote lost it
  }
  return op("upload", ReasonCode.NewLocalFile); // B,⌀/†,⌀ → new local file
}

const KIND_ORDER: Record<OperationKind, number> = {
  conflict: 0,
  download: 1,
  "delete-local": 2,
  upload: 3,
  "delete-remote": 4,
  noop: 5,
};

export function plan(
  local: FileDescriptor[],
  base: Manifest | null,
  remote: Manifest | null,
  opts: PlanOptions,
): SyncPlan {
  const localByPath = new Map<VaultPath, FileDescriptor>();
  for (const f of local) localByPath.set(f.path, f);

  const paths = new Set<VaultPath>(localByPath.keys());
  for (const m of [base, remote]) {
    if (m === null) continue;
    for (const p of Object.keys(m.files)) paths.add(p);
    for (const p of Object.keys(m.tombstones)) paths.add(p);
  }

  // Case-only collisions across local + incoming remote paths are conflicts,
  // never silent overwrites on case-insensitive filesystems (ADR-0007).
  const foldedLocal = new Map<string, VaultPath>();
  for (const p of localByPath.keys()) foldedLocal.set(p.toLowerCase(), p);

  const operations: Operation[] = [];
  const syncable = opts.syncable ?? (() => true);

  for (const path of paths) {
    // Out of this device's profile: it is not here because we do not carry it,
    // not because the user deleted it. Leave it alone in both directions.
    if (!localByPath.has(path) && !syncable(path)) continue;
    const localFile = localByPath.get(path);
    const localState: SideState =
      localFile === undefined ? ABSENT : { kind: "live", hash: localFile.hash };
    const o = classify(
      path,
      localState,
      manifestState(base, path),
      manifestState(remote, path),
    );
    if (o === null) continue;
    if (o.kind === "download") {
      const collided = foldedLocal.get(path.toLowerCase());
      if (collided !== undefined && collided !== path) {
        operations.push({
          ...o,
          kind: "conflict",
          reason: ReasonCode.ConflictSamePath,
        });
        continue;
      }
    }
    operations.push(o);
  }

  operations.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const summary = {
    uploads: operations.filter((o) => o.kind === "upload").length,
    downloads: operations.filter((o) => o.kind === "download").length,
    deletions: operations.filter(
      (o) => o.kind === "delete-local" || o.kind === "delete-remote",
    ).length,
    conflicts: operations.filter((o) => o.kind === "conflict").length,
  };

  // Safe-Sync bulk-change circuit breaker (ADR-0010 §4, ADR-0013 floor):
  // count DESTRUCTIVE ops — deletions plus downloads that replace an existing
  // local file. New-file downloads and uploads never destroy local bytes.
  // ≤ floor: routine, never prompt. ≥ maxFiles: always prompt. In between:
  // prompt when the change is a large fraction of the vault.
  //
  // ADR-0029: what is counted is the largest BURST at the source, not the size
  // of this plan — a plan is only as big as the gap since this device last
  // synced. A `delete-local` whose tombstone says when and by whom is paced;
  // everything else counts in full, because nothing else in the manifest
  // records WHEN a change was published (an entry's mtime is the file's, and a
  // restore from backup carries mtimes from years ago).
  const destructiveOps = operations.filter(
    (o) =>
      o.kind === "delete-local" ||
      o.kind === "delete-remote" ||
      (o.kind === "download" && o.localHash !== undefined),
  );
  const pacedDeletions: { at: number; device: DeviceId }[] = [];
  let unpaced = 0;
  for (const op of destructiveOps) {
    const tombstone = op.kind === "delete-local" ? remote?.tombstones[op.path] : undefined;
    if (tombstone === undefined) unpaced++;
    else pacedDeletions.push({ at: tombstone.deletedAt, device: tombstone.device });
  }
  const destructive = destructiveOps.length;
  const effective = unpaced + peakBurst(pacedDeletions, opts.deletionBurstWindow);
  const fires = (n: number): boolean =>
    n > opts.bulkChangeFloor &&
    (n >= opts.bulkChangeMaxFiles || n >= opts.bulkChangeMaxFraction * local.length);
  const requiresConfirmation = fires(effective);

  const pullFirst =
    remote !== null && remote.generation > (base?.generation ?? 0);

  const result: SyncPlan = {
    operations,
    pullFirst,
    requiresConfirmation,
    summary,
  };
  if (requiresConfirmation) {
    result.confirmationReason = {
      code: "bulk-change",
      destructive,
      total: local.length,
    };
  } else if (fires(destructive)) {
    // The one case where a safety net deliberately did not fire — say so
    // rather than letting a day's deletions land in silence (ADR-0029).
    result.pacingDiscount = {
      destructive,
      effective,
      paced: pacedDeletions.length,
      spanSeconds: span(pacedDeletions),
    };
  }
  return result;
}
