// Plan execution — RFC-0007 §7/§8, ADR-0010 (trash, retention), ADR-0012
// (conflict materialization). Every applied change produces a SyncReportEntry
// with a ReasonCode and a human message; conflict ops NEVER write over a file.

import { SyncError } from "../errors.js";
import type { Operation } from "../plan.js";
import { ReasonCode } from "../reasons.js";
import type { EntryDetail, SyncReportEntry } from "../report.js";
import type {
  DeviceId,
  FileDescriptor,
  Hash,
  Manifest,
  ManifestEntry,
  ObjectKey,
  Tombstone,
  VaultPath,
} from "../types.js";
import type { EngineContext } from "./context.js";

export interface PullApplyResult {
  entries: SyncReportEntry[];
  conflicts: VaultPath[];
  aborted: boolean;
}

export interface PushApplyResult {
  entries: SyncReportEntry[];
  /** New/changed manifest entries produced by uploads. */
  uploaded: Record<VaultPath, ManifestEntry>;
  /** Paths tombstoned by this push. */
  tombstoned: VaultPath[];
  aborted: boolean;
}

/** "dir/note (conflicted copy from <device> <date>).md" — RFC-0004, ADR-0012. */
export function conflictedCopyPath(
  path: VaultPath,
  device: DeviceId,
  epochSeconds: number,
  attempt = 0,
): VaultPath {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const date = new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  const counter = attempt > 0 ? ` ${attempt + 1}` : "";
  return `${dir}${stem} (conflicted copy from ${device} ${date}${counter})${ext}`;
}

/** Download + decrypt + VERIFY one manifest entry. Fail-closed on mismatch. */
async function fetchVerified(
  ctx: EngineContext,
  path: VaultPath,
  entry: ManifestEntry,
): Promise<Uint8Array> {
  const blob = await ctx.storage.get(ctx.key(entry.objectKey));
  const data = await ctx.crypto.decrypt("content", blob);
  const actual = await ctx.crypto.hash(data);
  if (actual !== entry.hash) {
    throw new SyncError(
      "CryptoAuthError",
      `object for "${path}" does not match its manifest hash (expected ${entry.hash}, got ${actual}) — not applied`,
    );
  }
  return data;
}

function reportEntry(
  op: Operation,
  opts: { detail?: EntryDetail; bytes?: number } = {},
): SyncReportEntry {
  const e: SyncReportEntry = {
    path: op.path,
    kind: op.kind,
    reason: op.reason,
  };
  if (opts.detail !== undefined) e.detail = opts.detail;
  if (opts.bytes !== undefined) e.bytes = opts.bytes;
  return e;
}

/** Find a conflicted-copy path that does not exist locally yet. */
async function freeCopyPath(
  ctx: EngineContext,
  path: VaultPath,
  device: DeviceId,
): Promise<VaultPath> {
  for (let attempt = 0; ; attempt++) {
    const candidate = conflictedCopyPath(path, device, ctx.clock.now(), attempt);
    if ((await ctx.vault.stat(candidate)) === null) return candidate;
  }
}

/**
 * Write a file we just fetched and remember its hash (ADR-0023).
 *
 * We already know what these bytes hash to — it is what we verified the
 * download against — so recording it with a fresh stat spares the next scan a
 * full re-read of everything a first sync just downloaded. Purely an
 * optimization: a failed stat, or no cache at all, just means a re-hash later.
 */
async function writeAndRemember(
  ctx: EngineContext,
  path: VaultPath,
  data: Uint8Array,
  hash: Hash,
): Promise<void> {
  await ctx.vault.write(path, data);
  if (ctx.hashCache === undefined) return;
  const stat = await ctx.vault.stat(path);
  if (stat === null) return;
  ctx.hashCache.set(path, { size: stat.size, mtime: stat.mtime, hash });
}

/**
 * Apply the pull side of a plan: downloads, remote deletions (via trash),
 * and conflict materialization (ADR-0012). Upload/delete-remote ops are the
 * push side and are skipped here.
 */
export async function applyPullOps(
  ctx: EngineContext,
  operations: Operation[],
  remote: Manifest,
  signal?: AbortSignal,
): Promise<PullApplyResult> {
  const entries: SyncReportEntry[] = [];
  const conflicts: VaultPath[] = [];
  let aborted = false;

  for (const op of operations) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    switch (op.kind) {
      case "download": {
        const entry = remote.files[op.path];
        if (entry === undefined) continue; // planner/remote drift — nothing to fetch
        // A download the planner classified as a CREATION (no local hash: the
        // scan saw nothing at this path) must not land on top of a file. If
        // one is there now, the plan's picture of this path is wrong, and
        // overwriting it is the silent overwrite this project exists to avoid.
        //
        // Two ways it gets there. A case-insensitive filesystem folds two
        // manifest paths onto one file: "Note.md" and "note.md" are both new
        // to this device, the planner cannot know the filesystem folds them —
        // it is pure, and the answer differs per platform — so it emits two
        // creations and the second used to overwrite the first (ADR-0007 says
        // case-only collisions are conflicts, never dupes or overwrites; the
        // existing check only looks at paths the scan already saw). And the
        // ordinary race: the user created the file between the scan and now.
        //
        // Asking the filesystem is what makes this exact rather than a guess
        // about case sensitivity, and it costs one stat per created file.
        if (op.localHash === undefined && (await ctx.vault.stat(op.path)) !== null) {
          const copyPath = await freeCopyPath(ctx, op.path, remote.device);
          const data = await fetchVerified(ctx, op.path, entry);
          await writeAndRemember(ctx, copyPath, data, entry.hash);
          conflicts.push(op.path);
          entries.push(
            reportEntry(
              { ...op, kind: "conflict", reason: ReasonCode.ConflictSamePath },
              { detail: { code: "conflict-copy-saved", copyPath }, bytes: data.length },
            ),
          );
          break;
        }
        const data = await fetchVerified(ctx, op.path, entry);
        await writeAndRemember(ctx, op.path, data, entry.hash);
        entries.push(reportEntry(op, { bytes: data.length }));
        break;
      }
      case "delete-local": {
        // ADR-0010 §1: through trash, never a hard delete.
        await ctx.vault.trash(op.path);
        ctx.hashCache?.delete(op.path);
        entries.push(reportEntry(op));
        break;
      }
      case "conflict": {
        conflicts.push(op.path);
        const remoteEntry = remote.files[op.path];
        if (remoteEntry !== undefined && op.localHash !== undefined) {
          // Both sides have a version: keep local at the path, materialize the
          // remote version ALONGSIDE (never over) as a conflicted copy.
          const copyPath = await freeCopyPath(ctx, op.path, remote.device);
          const data = await fetchVerified(ctx, op.path, remoteEntry);
          await writeAndRemember(ctx, copyPath, data, remoteEntry.hash);
          entries.push(
            reportEntry(op, {
              detail: { code: "conflict-copy-saved", copyPath },
              bytes: data.length,
            }),
          );
        } else if (remoteEntry !== undefined) {
          // Deleted locally, edited remotely: restore the remote version
          // (a creation — the path is locally absent). Edit beats delete.
          const data = await fetchVerified(ctx, op.path, remoteEntry);
          await writeAndRemember(ctx, op.path, data, remoteEntry.hash);
          entries.push(
            reportEntry(op, {
              detail: { code: "remote-edit-restored" },
              bytes: data.length,
            }),
          );
        } else {
          // Edited locally, deleted remotely: keep the local file untouched;
          // the next push revives it. Edit beats delete.
          entries.push(reportEntry(op, { detail: { code: "local-edit-kept" } }));
        }
        break;
      }
      case "upload":
      case "delete-remote":
      case "noop":
        break; // push side / nothing to do
    }
  }
  return { entries, conflicts, aborted };
}

/**
 * Apply the push side of a plan: upload content objects (idempotent —
 * content-addressed keys) and collect tombstones. Does NOT publish the
 * manifest; that is the caller's commit step (ADR-0006).
 */
export async function applyPushOps(
  ctx: EngineContext,
  operations: Operation[],
  local: FileDescriptor[],
  signal?: AbortSignal,
): Promise<PushApplyResult> {
  const localByPath = new Map(local.map((f) => [f.path, f]));
  const entries: SyncReportEntry[] = [];
  const uploaded: Record<VaultPath, ManifestEntry> = {};
  const tombstoned: VaultPath[] = [];
  /** Objects the dedup probe let us skip uploading — see confirmAdopted. */
  const adopted: { path: VaultPath; objectKey: ObjectKey }[] = [];
  let aborted = false;

  for (const op of operations) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    switch (op.kind) {
      case "upload": {
        const data = await ctx.vault.read(op.path);
        // Re-hash the actual bytes read: the file may have changed since the
        // scan, and the manifest must describe exactly what was uploaded.
        const hash = await ctx.crypto.hash(data);
        const objectKey = await ctx.crypto.objectKeyFor(hash);
        // Deduplication probe: skip the upload when this exact content is
        // already stored. It is an OPTIMIZATION — objects are addressed by
        // content hash, so re-uploading is harmless. A storage that cannot
        // answer the probe must therefore not fail the sync: we upload
        // instead, and a genuinely unreachable storage fails at the put.
        let exists = true;
        let probeAnswered = true;
        try {
          await ctx.storage.stat(ctx.key(objectKey));
        } catch (e) {
          const notFound = e instanceof SyncError && e.code === "StorageNotFound";
          if (!notFound) {
            if (!(e instanceof SyncError) || e.code !== "StorageTransient") throw e;
            probeAnswered = false;
            ctx.log.notice({
              code: "dedup-probe-unavailable",
              path: op.path,
              detail: e.message,
            });
          }
          exists = false;
        }
        if (!exists) {
          const blob = await ctx.crypto.encrypt("content", data);
          // An object's key IS its content hash, so a rewrite could only ever
          // replace bytes with identical bytes. Even so, when the probe could
          // not answer we ask the storage to CREATE-IF-ABSENT where it can:
          // "never overwrite blindly" then holds by construction, not by
          // argument. A precondition failure means it was already there.
          const guard =
            !probeAnswered && ctx.storage.capabilities().conditionalWrites
              ? { ifNoneMatch: "*" as const }
              : {};
          try {
            await ctx.storage.put(ctx.key(objectKey), blob, guard);
          } catch (e) {
            if (!(e instanceof SyncError) || e.code !== "StoragePreconditionFailed") throw e;
            // Already stored by this or another device — the desired end state.
          }
        }
        // Uploaded nothing because the probe said it was already there: the
        // manifest this push publishes will point at bytes THIS push did not
        // write. Remembered so they can be checked again at the last moment.
        if (exists) adopted.push({ path: op.path, objectKey });
        const mtime = localByPath.get(op.path)?.mtime ?? ctx.clock.now();
        uploaded[op.path] = { hash, size: data.length, mtime, objectKey };
        entries.push(reportEntry(op, { bytes: data.length }));
        break;
      }
      case "delete-remote": {
        tombstoned.push(op.path);
        entries.push(reportEntry(op));
        break;
      }
      case "download":
      case "delete-local":
      case "conflict":
      case "noop":
        break; // pull side / nothing to do
    }
  }
  if (!aborted) await confirmAdopted(ctx, adopted, signal);
  return { entries, uploaded, tombstoned, aborted };
}

/**
 * Re-check the objects the dedup probe let this push adopt — as late as this
 * layer can, right before the caller builds and publishes the manifest.
 *
 * The probe skips uploading content that is already stored. Reclaim's grace
 * window exists because such an object can be swept between the probe and the
 * manifest that names it (ADR-0030), and the window is only as good as the
 * clocks behind it: with a shared mark, one slow device collapsed it to zero
 * and this race stopped being theoretical — a push reported `applied`, the
 * manifest went out, and every device's pull died on bytes that were gone.
 * The mark is per-device now, but the window still bounds one push and a push
 * over a mobile link is not instantaneous.
 *
 * So: prove they are still there, or publish nothing. Failing the push is the
 * whole fix — the next one re-probes, finds the object missing, and uploads it
 * for real. Re-uploading from here instead would mean holding every adopted
 * file's plaintext in memory for the length of the push, to repair something
 * that should almost never happen.
 *
 * A storage that cannot ANSWER is not evidence of absence and does not fail
 * the push: the same rule the probe itself follows.
 */
async function confirmAdopted(
  ctx: EngineContext,
  adopted: readonly { path: VaultPath; objectKey: ObjectKey }[],
  signal?: AbortSignal,
): Promise<void> {
  for (const { path, objectKey } of adopted) {
    if (signal?.aborted) return;
    try {
      await ctx.storage.stat(ctx.key(objectKey));
    } catch (e) {
      if (!(e instanceof SyncError) || e.code !== "StorageNotFound") continue;
      throw new SyncError(
        "StorageTransient",
        `object for "${path}" was in storage when this push started and is gone now ` +
          `(${objectKey}) — publishing would name ciphertext nobody can fetch. ` +
          `Nothing was published; the next sync uploads it.`,
      );
    }
  }
}

/**
 * Build generation Gmax+1 from the remote manifest plus this push's changes.
 * Prior versions of replaced/deleted entries go to `history` (ADR-0010 §3).
 */
export function buildNextManifest(
  ctx: EngineContext,
  remote: Manifest | null,
  generation: number,
  uploaded: Record<VaultPath, ManifestEntry>,
  tombstoned: VaultPath[],
): Manifest {
  const files: Record<VaultPath, ManifestEntry> = { ...(remote?.files ?? {}) };
  const tombstones: Record<VaultPath, Tombstone> = {
    ...(remote?.tombstones ?? {}),
  };
  const history: Record<VaultPath, ManifestEntry[]> = { ...(remote?.history ?? {}) };

  const retain = (path: VaultPath, prior: ManifestEntry | undefined): void => {
    if (prior === undefined || ctx.versionsToKeep <= 0) return;
    const existing = history[path] ?? [];
    // `versionsToKeep` is a per-DEVICE setting applied to a SHARED structure.
    // A phone set to keep one version used to cut a path's history to one on
    // its next edit of it — discarding versions the desktop was retaining, and
    // handing their ciphertext to the next reclaim (ADR-0045). A push may add
    // its own version and rotate the list; it may not make the list shorter
    // than it found it.
    const depth = Math.max(ctx.versionsToKeep, existing.length);
    history[path] = [prior, ...existing].slice(0, depth);
  };

  for (const [path, entry] of Object.entries(uploaded)) {
    const prior = files[path];
    if (prior !== undefined && prior.hash !== entry.hash) retain(path, prior);
    files[path] = entry;
    delete tombstones[path]; // a revived path is live again
  }
  for (const path of tombstoned) {
    retain(path, files[path]);
    delete files[path];
    tombstones[path] = { deletedAt: ctx.clock.now(), device: ctx.deviceId };
  }

  // ADR-0031: a tombstone older than the grace window has done its job. The
  // worst this costs is a file coming BACK on a device that has been offline
  // longer than the window (RFC-0004's A,A,⌀ anomaly re-uploads it) — the
  // opposite failure from every other one in this project. Never expiring them
  // means the manifest grows with every deletion the vault has ever seen, and
  // the ciphertext of deleted files can never be reclaimed (ADR-0030), because
  // `history` keeps pointing at it.
  let expired = 0;
  if (ctx.tombstoneGraceSeconds > 0) {
    const cutoff = ctx.clock.now() - ctx.tombstoneGraceSeconds;
    for (const [path, tombstone] of Object.entries(tombstones)) {
      if (tombstone.deletedAt >= cutoff) continue;
      delete tombstones[path];
      // Retained versions of a path nobody remembers deleting are unreachable
      // by definition — they go with it, or GC can never free them.
      delete history[path];
      expired++;
    }
  }
  if (expired > 0) {
    ctx.log.notice({
      code: "tombstones-expired",
      count: expired,
      graceSeconds: ctx.tombstoneGraceSeconds,
    });
  }

  const manifest: Manifest = {
    version: 1,
    generation,
    device: ctx.deviceId,
    updatedAt: ctx.clock.now(),
    files,
    tombstones,
  };
  if (Object.keys(history).length > 0) manifest.history = history;
  if (ctx.clientVersion !== undefined) manifest.writer = ctx.clientVersion;
  return manifest;
}
