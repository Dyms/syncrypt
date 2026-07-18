// FilesystemStorage — StoragePort over a local directory (RFC-0006).
// The deterministic test backend and the "local folder / external drive"
// provider. Node-only APIs are allowed here (this is an edge adapter).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  SyncError,
  type ObjectKey,
  type ObjectStat,
  type ProviderCapabilities,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from "@syncrypt/core";

export interface FilesystemStorageOptions {
  /** Honor ifMatch/ifNoneMatch (advertised via capabilities). Default true;
   *  set false to exercise the universal LIST-based protocol (ADR-0006). */
  conditionalWrites?: boolean;
}

const TMP_MARKER = ".syncrypt-tmp-";

function keyToRelative(key: ObjectKey): string {
  if (key.length === 0) throw badKey(key);
  const segments = key.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.includes("\\")) throw badKey(key);
  }
  return segments.join(path.sep);
}

function badKey(key: ObjectKey): SyncError {
  return new SyncError("StorageNotFound", `invalid object key: "${key}"`);
}

function etagOf(data: Uint8Array): string {
  return `"${createHash("sha256").update(data).digest("hex").slice(0, 32)}"`;
}

function isNoEnt(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
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
      const tmp = `${target}${TMP_MARKER}${process.pid.toString(36)}${Date.now().toString(36)}`;
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
        if (entry.name.includes(TMP_MARKER)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile()) keys.push(childRel);
      }
    };
    await walk(this.root, "");
    for (const key of keys.filter((k) => k.startsWith(prefix)).sort()) {
      yield await this.stat(key);
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
