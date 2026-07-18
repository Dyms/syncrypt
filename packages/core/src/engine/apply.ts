// Plan execution — RFC-0007 §7/§8, ADR-0010 (trash, retention), ADR-0012
// (conflict materialization). Every applied change produces a SyncReportEntry
// with a ReasonCode and a human message; conflict ops NEVER write over a file.

import { SyncError } from "../errors.js";
import type { Operation } from "../plan.js";
import { reasonMessage } from "../reasons.js";
import type { SyncReportEntry } from "../report.js";
import type {
  DeviceId,
  FileDescriptor,
  Manifest,
  ManifestEntry,
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
  message: string,
  bytes?: number,
): SyncReportEntry {
  const e: SyncReportEntry = {
    path: op.path,
    kind: op.kind,
    reason: op.reason,
    message,
  };
  if (bytes !== undefined) e.bytes = bytes;
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
        const data = await fetchVerified(ctx, op.path, entry);
        await ctx.vault.write(op.path, data);
        entries.push(reportEntry(op, reasonMessage(op.reason), data.length));
        break;
      }
      case "delete-local": {
        // ADR-0010 §1: through trash, never a hard delete.
        await ctx.vault.trash(op.path);
        entries.push(reportEntry(op, reasonMessage(op.reason)));
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
          await ctx.vault.write(copyPath, data);
          entries.push(
            reportEntry(
              op,
              `${reasonMessage(op.reason)} — remote version saved as "${copyPath}"`,
              data.length,
            ),
          );
        } else if (remoteEntry !== undefined) {
          // Deleted locally, edited remotely: restore the remote version
          // (a creation — the path is locally absent). Edit beats delete.
          const data = await fetchVerified(ctx, op.path, remoteEntry);
          await ctx.vault.write(op.path, data);
          entries.push(
            reportEntry(
              op,
              `${reasonMessage(op.reason)} — restored the remotely-edited version; delete again to confirm`,
              data.length,
            ),
          );
        } else {
          // Edited locally, deleted remotely: keep the local file untouched;
          // the next push revives it. Edit beats delete.
          entries.push(
            reportEntry(
              op,
              `${reasonMessage(op.reason)} — kept the locally-edited file; it will be re-uploaded`,
            ),
          );
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
        let exists = true;
        try {
          await ctx.storage.stat(ctx.key(objectKey));
        } catch (e) {
          if (!(e instanceof SyncError) || e.code !== "StorageNotFound") throw e;
          exists = false;
        }
        if (!exists) {
          const blob = await ctx.crypto.encrypt("content", data);
          await ctx.storage.put(ctx.key(objectKey), blob);
        }
        const mtime = localByPath.get(op.path)?.mtime ?? ctx.clock.now();
        uploaded[op.path] = { hash, size: data.length, mtime, objectKey };
        entries.push(reportEntry(op, reasonMessage(op.reason), data.length));
        break;
      }
      case "delete-remote": {
        tombstoned.push(op.path);
        entries.push(reportEntry(op, reasonMessage(op.reason)));
        break;
      }
      case "download":
      case "delete-local":
      case "conflict":
      case "noop":
        break; // pull side / nothing to do
    }
  }
  return { entries, uploaded, tombstoned, aborted };
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
    history[path] = [prior, ...(history[path] ?? [])].slice(0, ctx.versionsToKeep);
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

  const manifest: Manifest = {
    version: 1,
    generation,
    device: ctx.deviceId,
    updatedAt: ctx.clock.now(),
    files,
    tombstones,
  };
  if (Object.keys(history).length > 0) manifest.history = history;
  return manifest;
}
