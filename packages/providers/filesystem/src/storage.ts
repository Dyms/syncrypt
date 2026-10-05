// FilesystemStorage — StoragePort over a local directory (RFC-0006).
// The deterministic test backend and the "local folder / external drive"
// provider. Node-only APIs are allowed here (this is an edge adapter).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  isSyncError,
  isUsableObjectKey,
  SyncError,
  type ObjectKey,
  type ObjectStat,
  type ProviderCapabilities,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from "@syncrypt/core";

import { isTmpName, tmpPathFor } from "./tmp.js";

export interface FilesystemStorageOptions {
  /** Honor ifMatch/ifNoneMatch (advertised via capabilities). Default true;
   *  set false to exercise the universal LIST-based protocol (ADR-0006). */
  conditionalWrites?: boolean;
}



function keyToRelative(key: ObjectKey): string {
  // The shared rule (ADR-0058), plus one this provider adds: a backslash is a
  // path separator where this one writes, so a key carrying one would escape
  // the root on Windows exactly as ".." would.
  if (!isUsableObjectKey(key)) throw badKey(key);
  const segments = key.split("/");
  for (const s of segments) if (s.includes("\\")) throw badKey(key);
  return segments.join(path.sep);
}

function badKey(key: ObjectKey): SyncError {
  return new SyncError("StorageNotFound", `invalid object key: "${key}"`);
}

function etagOf(data: Uint8Array): string {
  return `"${createHash("sha256").update(data).digest("hex").slice(0, 32)}"`;
}

function errno(e: unknown): string | undefined {
  return typeof e === "object" && e !== null
    ? (e as NodeJS.ErrnoException).code
    : undefined;
}

function isNoEnt(e: unknown): boolean {
  return errno(e) === "ENOENT";
}

/**
 * Errors that mean THERE IS NO OBJECT AT THIS KEY, not that the filesystem
 * misbehaved.
 *
 * `ENOENT` is the obvious one. The others are this provider's own shape
 * leaking: a key whose path happens to be a directory (`a` when only `a/1`
 * exists) answers EISDIR, a key under a non-directory answers ENOTDIR, and a
 * key the filesystem considers too long answers ENAMETOOLONG. All three used
 * to become `StorageTransient`, which the engine RETRIES with backoff — so
 * "there is nothing here" was reported as "the disk is having a moment"
 * (ADR-0061). RFC-0006 says a read of an absent key is StorageNotFound.
 *
 * Reads only. A WRITE that fails with EISDIR genuinely failed and is not
 * "absent".
 */
function isAbsentOnRead(e: unknown): boolean {
  const code = errno(e);
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

function normalizeFsError(e: unknown, key: ObjectKey): SyncError {
  if (e instanceof SyncError) return e;
  if (isNoEnt(e)) return new SyncError("StorageNotFound", `not found: ${key}`, e);
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new SyncError("StorageUnauthorized", `access denied: ${key}`, e);
  }
  return new SyncError("StorageTransient", `filesystem error on ${key}: ${String(e)}`, e);
}

export class FilesystemStorage implements StoragePort {
  private readonly root: string;
  private readonly conditional: boolean;
  /** Serializes writes so conditional checks are atomic within this process. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string, opts: FilesystemStorageOptions = {}) {
    this.root = path.resolve(rootDir);
    this.conditional = opts.conditionalWrites ?? true;
  }

  private fullPath(key: ObjectKey): string {
    return path.join(this.root, keyToRelative(key));
  }

  put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    const run = this.writeQueue.then(() => this.doPut(key, data, opts));
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doPut(
    key: ObjectKey,
    data: Uint8Array,
    opts?: PutOptions,
  ): Promise<PutResult> {
    const target = this.fullPath(key);
    try {
      if (this.conditional && opts) {
        const current = await this.tryReadEtag(target);
        if (opts.ifNoneMatch === "*" && current !== null) {
          throw new SyncError("StoragePreconditionFailed", `object exists: ${key}`);
        }
        if (opts.ifMatch !== undefined && current !== opts.ifMatch) {
          throw new SyncError("StoragePreconditionFailed", `etag mismatch: ${key}`);
        }
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = tmpPathFor(target);
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, target); // atomic replace
      return { etag: etagOf(data) };
    } catch (e) {
      throw normalizeFsError(e, key);
    }
  }

  private async tryReadEtag(target: string): Promise<string | null> {
    try {
      return etagOf(new Uint8Array(await fs.readFile(target)));
    } catch (e) {
      if (isNoEnt(e)) return null;
      throw e;
    }
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fs.readFile(this.fullPath(key)));
    } catch (e) {
      if (isAbsentOnRead(e)) throw new SyncError("StorageNotFound", `not found: ${key}`, e);
      throw normalizeFsError(e, key);
    }
  }

  async stat(key: ObjectKey): Promise<ObjectStat> {
    try {
      const target = this.fullPath(key);
      const [st, data] = await Promise.all([fs.stat(target), fs.readFile(target)]);
      return {
        key,
        size: st.size,
        etag: etagOf(new Uint8Array(data)),
        lastModified: Math.floor(st.mtimeMs / 1000),
      };
    } catch (e) {
      if (isAbsentOnRead(e)) throw new SyncError("StorageNotFound", `not found: ${key}`, e);
      throw normalizeFsError(e, key);
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    const keys: ObjectKey[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (isNoEnt(e)) return; // empty store
        throw normalizeFsError(e, prefix);
      }
      for (const entry of entries) {
        if (isTmpName(entry.name)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile()) keys.push(childRel);
      }
    };
    await walk(this.root, "");
    for (const key of keys.filter((k) => k.startsWith(prefix)).sort()) {
      // The walk collected names; stat reads them one at a time, and between
      // the two another device's reclamation can delete one. RFC-0006 gives
      // `list` no way to say NotFound (ADR-0058): a file that is gone is not
      // in the listing, and the walk goes on. Every other failure — a
      // permission error, a disk giving up — is an answer ABOUT a file that
      // exists and still ends the walk.
      let stat: ObjectStat;
      try {
        stat = await this.stat(key);
      } catch (e) {
        if (isSyncError(e, "StorageNotFound")) continue;
        throw e;
      }
      yield stat;
    }
  }

  async delete(key: ObjectKey): Promise<void> {
    try {
      await fs.rm(this.fullPath(key), { force: true }); // idempotent
    } catch (e) {
      throw normalizeFsError(e, key);
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      conditionalWrites: this.conditional,
      objectVersioning: false,
      maxSinglePutBytes: 5 * 1024 * 1024 * 1024,
    };
  }
}
