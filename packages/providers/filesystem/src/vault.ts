// FilesystemVault — VaultPort over a plain directory. The headless test/CLI
// vault adapter (the Obsidian adapter is in @syncrypt/obsidian-plugin).
//
// - Paths are canonicalized (NFC, POSIX) at the boundary (ADR-0007).
// - trash() moves files into the Safe-Sync trash folder, never hard-deletes
//   (ADR-0010 §1); the trash folder is excluded from list().
// - Dot-directories (.obsidian, .git, …) are excluded from list() — the M1
//   stand-in for sync profiles (RFC-0002 FR-1..3).

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  canonicalizePath,
  SyncError,
  type VaultPath,
  type VaultPort,
  type WrittenStat,
} from "@syncrypt/core";

import { isTmpName, tmpPathFor } from "./tmp.js";

export interface FilesystemVaultOptions {
  /** Vault-relative Safe-Sync trash folder (ADR-0010). */
  trashDir?: string;
}

const DEFAULT_TRASH_DIR = ".obsidian/sync-trash";

function isNoEnt(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class FilesystemVault implements VaultPort {
  private readonly root: string;
  private readonly trashDir: string;

  constructor(rootDir: string, opts: FilesystemVaultOptions = {}) {
    this.root = path.resolve(rootDir);
    this.trashDir = opts.trashDir ?? DEFAULT_TRASH_DIR;
  }

  private fullPath(p: VaultPath): string {
    return path.join(this.root, this.toNative(p));
  }

  async *list(): AsyncIterable<VaultPath> {
    const found: VaultPath[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (isNoEnt(e)) return;
        throw e;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // profiles stand-in; excludes trash
        // A write that was interrupted leaves one of these behind. It is not a
        // note: listing it uploads a fragment of a half-finished download to
        // every device, under a name ending in random characters, for ever
        // (ADR-0060). The storage adapter in this package has always skipped
        // them; this one wrote them and then listed them.
        if (isTmpName(entry.name)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile()) found.push(this.fromNative(childRel));
      }
    };
    await walk(this.root, "");
    for (const p of found.sort()) yield p;
  }

  async read(p: VaultPath): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fs.readFile(this.fullPath(p)));
    } catch (e) {
      if (isNoEnt(e)) throw new SyncError("VaultFileNotFound", `not found: ${p}`, e);
      throw new SyncError("VaultWriteFailed", `cannot read ${p}: ${String(e)}`, e);
    }
  }

  async write(p: VaultPath, data: Uint8Array): Promise<WrittenStat> {
    const target = this.fullPath(p);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = tmpPathFor(target);
      await fs.writeFile(tmp, data);
      // The temp file's stat is the stat of exactly these bytes: nobody else
      // writes a name only this call knows, and rename keeps size and mtime.
      // A save after the rename changes the mtime (ADR-0082).
      const st = await fs.stat(tmp);
      await fs.rename(tmp, target); // atomic replace
      return { size: st.size, mtime: st.mtimeMs / 1000 };
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot write ${p}: ${String(e)}`, e);
    }
  }

  async trash(p: VaultPath): Promise<void> {
    const source = this.fullPath(p);
    try {
      if (
        await fs.stat(source).then(
          () => false,
          (e: unknown) => isNoEnt(e),
        )
      ) {
        return; // already gone — trash is idempotent
      }
      const base = path.join(this.root, this.toNative(this.trashDir), this.toNative(p));
      await fs.mkdir(path.dirname(base), { recursive: true });
      let target = base;
      for (let attempt = 1; ; attempt++) {
        const exists = await fs.stat(target).then(
          () => true,
          () => false,
        );
        if (!exists) break; // keep earlier trashed versions, never overwrite them
        target = `${base}.${attempt}`;
      }
      await fs.rename(source, target);
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot trash ${p}: ${String(e)}`, e);
    }
  }

  async delete(p: VaultPath): Promise<void> {
    try {
      await fs.rm(this.fullPath(p), { force: true });
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot delete ${p}: ${String(e)}`, e);
    }
  }

  async stat(p: VaultPath): Promise<{ size: number; mtime: number } | null> {
    try {
      const st = await fs.stat(this.fullPath(p));
      // Sub-second precision: a same-size rewrite within the same second must
      // still invalidate the (path,size,mtime) hash-cache key.
      return { size: st.size, mtime: st.mtimeMs / 1000 };
    } catch (e) {
      if (isNoEnt(e)) return null;
      throw new SyncError("VaultWriteFailed", `cannot stat ${p}: ${String(e)}`, e);
    }
  }

  toNative(p: VaultPath): string {
    return p.split("/").join(path.sep);
  }

  fromNative(native: string): VaultPath {
    return canonicalizePath(native.split(path.sep).join("/"));
  }
}
