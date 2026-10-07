// What a comparison needs, and how it is loaded (RFC-0010). Pure: the vault and
// the engine arrive as functions, so this runs under vitest without `obsidian`.
//
// Nothing is fetched before the sizes are known. A 200 MB PDF in a Safe-Sync
// list must not turn a click on "Compare" into a 200 MB download just to be told
// "too large to show".

import type { FileVersions, Operation, VaultPath } from "@syncrypt/core";

import { compareBytes, MAX_DIFF_BYTES, type DiffResult } from "./text-diff.js";

export type Side =
  | { kind: "local" }
  | { kind: "stored"; hash: string }
  | { kind: "absent" };

export interface CompareRequest {
  path: VaultPath;
  left: Side;
  right: Side;
}

/**
 * What to compare for one line of the Safe-Sync dialog, or null when there is
 * nothing to look at. Left is what is there now, right is what the sync would
 * leave — so a removed line is a line that would be lost.
 */
export function requestForOperation(op: Operation): CompareRequest | null {
  switch (op.kind) {
    case "download":
    case "conflict":
      if (op.localHash === undefined || op.remoteHash === undefined) return null;
      return {
        path: op.path,
        left: { kind: "local" },
        right: { kind: "stored", hash: op.remoteHash },
      };
    case "delete-local":
      return { path: op.path, left: { kind: "local" }, right: { kind: "absent" } };
    case "delete-remote":
      if (op.remoteHash === undefined) return null;
      return {
        path: op.path,
        left: { kind: "stored", hash: op.remoteHash },
        right: { kind: "absent" },
      };
    default:
      return null;
  }
}

export interface SideInfo {
  side: Side;
  /** Null when there is no file on that side. */
  size: number | null;
  /** Epoch seconds; null when unknown or absent. */
  mtime: number | null;
}

export interface Comparison {
  path: VaultPath;
  left: SideInfo;
  right: SideInfo;
  result: DiffResult;
}

export interface CompareDeps {
  /** Null when there is no such local file. */
  localStat(path: VaultPath): Promise<{ size: number; mtime: number } | null>;
  readLocal(path: VaultPath): Promise<Uint8Array>;
  listVersions(path: VaultPath, signal?: AbortSignal): Promise<FileVersions>;
  readStored(path: VaultPath, hash: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export class VersionGoneError extends Error {
  constructor(readonly path: VaultPath) {
    super(`storage no longer holds that version of ${path}`);
    this.name = "VersionGoneError";
  }
}

export async function loadComparison(
  req: CompareRequest,
  deps: CompareDeps,
  signal?: AbortSignal,
): Promise<Comparison> {
  let versions: FileVersions | null = null;
  const info = async (side: Side): Promise<SideInfo> => {
    if (side.kind === "absent") return { side, size: null, mtime: null };
    if (side.kind === "local") {
      const stat = await deps.localStat(req.path);
      if (stat === null) return { side: { kind: "absent" }, size: null, mtime: null };
      return { side, size: stat.size, mtime: stat.mtime };
    }
    versions ??= await deps.listVersions(req.path, signal);
    const v = versions.versions.find((x) => x.hash === side.hash);
    if (v === undefined) throw new VersionGoneError(req.path);
    return { side, size: v.size, mtime: v.mtime };
  };
  const left = await info(req.left);
  const right = await info(req.right);

  if ((left.size ?? 0) > MAX_DIFF_BYTES || (right.size ?? 0) > MAX_DIFF_BYTES) {
    return { path: req.path, left, right, result: { kind: "too-large", reason: "bytes" } };
  }
  const bytes = async (i: SideInfo): Promise<Uint8Array | null> => {
    if (i.side.kind === "absent") return null;
    if (i.side.kind === "local") return deps.readLocal(req.path);
    return deps.readStored(req.path, i.side.hash, signal);
  };
  const a = await bytes(left);
  const b = await bytes(right);
  return { path: req.path, left, right, result: compareBytes(a, b) };
}

/**
 * Where a restored version goes: next to the file, named for the version's own
 * date, never over anything that exists. Restore is never in place — the person
 * copies what they want from the copy.
 */
export async function restoredCopyPath(
  path: VaultPath,
  mtimeSeconds: number,
  exists: (candidate: VaultPath) => Promise<boolean>,
): Promise<VaultPath> {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const date = new Date(mtimeSeconds * 1000).toISOString().slice(0, 10);
  for (let attempt = 1; ; attempt++) {
    const counter = attempt > 1 ? ` ${String(attempt)}` : "";
    const candidate = `${dir}${stem} (restored from ${date}${counter})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
}
