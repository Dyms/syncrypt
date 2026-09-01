// ObsidianVault — VaultPort over Obsidian's DataAdapter (RFC-0007 §2.2).
//
// - Canonical ↔ native path bridging with NFC normalization (ADR-0007);
//   macOS may hand back NFD paths — everything is normalized on the way in.
// - trash() moves files into `.obsidian/sync-trash/` — a Syncrypt-controlled,
//   NEVER-synced folder (ADR-0010 §1) — not Obsidian's own trash and never a
//   hard delete.
// - Dot-folders and the trash are hard-excluded from list(); the user's sync
//   profile filters the rest.
// - `.obsidian` is the ONE exception, and only when config sync is enabled
//   (RFC-0008): then an explicit allow-list of config paths is walked, decided
//   solely by config-sync settings — the note profile never applies to them.

import {
  canonicalizePath,
  SyncError,
  type VaultPath,
  type VaultPort,
} from "@syncrypt/core";

import type { DataAdapterLike } from "./adapter-types.js";
import {
  configPaths,
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_SYNC,
  type ConfigPaths,
  type ConfigSyncSettings,
} from "./config-sync.js";
import { ProfileMatcher, type SyncProfile } from "./profile.js";

/**
 * The trash under a DEFAULT config folder. Only for callers that have no vault
 * instance to ask; anything holding a vault uses `ConfigPaths.syncTrash`.
 */
export const DEFAULT_SYNC_TRASH_DIR = `${DEFAULT_CONFIG_DIR}/sync-trash`;

export class ObsidianVault implements VaultPort {
  private readonly matcher: ProfileMatcher;

  constructor(
    private readonly adapter: DataAdapterLike,
    profile: SyncProfile,
    private readonly configSync: ConfigSyncSettings = DEFAULT_CONFIG_SYNC,
    /** The vault's config folder (`Vault.configDir`), not an assumption. */
    private readonly paths: ConfigPaths = configPaths(DEFAULT_CONFIG_DIR),
  ) {
    this.matcher = new ProfileMatcher(profile);
  }

  async *list(): AsyncIterable<VaultPath> {
    const found: VaultPath[] = [];
    const walk = async (folder: string): Promise<void> => {
      const { files, folders } = await this.adapter.list(folder);
      for (const file of files) {
        const canonical = this.fromNative(file);
        if (this.paths.inside(canonical)) {
          // Config files answer to config-sync settings only (RFC-0008).
          if (this.paths.allowed(canonical, this.configSync)) found.push(canonical);
          continue;
        }
        if (basename(canonical).startsWith(".")) continue;
        if (this.matcher.matches(canonical)) found.push(canonical);
      }
      for (const sub of folders) {
        const canonical = this.fromNative(sub);
        // Hard invariants first: sync-trash is never walked, and dot-folders
        // are skipped except `.obsidian` under an explicit config-sync opt-in.
        if (canonical === this.paths.syncTrash) continue;
        if (this.paths.inside(canonical)) {
          if (this.paths.worthWalking(canonical, this.configSync)) await walk(sub);
          continue;
        }
        if (basename(canonical).startsWith(".")) continue;
        if (this.matcher.folderExcluded(canonical)) continue;
        await walk(sub);
      }
    };
    await walk("");
    for (const p of found.sort()) yield p;
  }

  /**
   * The same rule list() applies, exposed to the engine (ADR-0022) so a file
   * this device does not carry is never read as a deletion — and never
   * downloaded here either.
   */
  syncable(path: VaultPath): boolean {
    const trash = this.paths.syncTrash;
    if (path === trash || path.startsWith(`${trash}/`)) return false;
    if (this.paths.inside(path)) return this.paths.allowed(path, this.configSync);
    if (basename(path).startsWith(".")) return false;
    if (path.split("/").some((segment) => segment.startsWith("."))) return false;
    return this.matcher.matches(path);
  }

  async read(path: VaultPath): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.adapter.readBinary(this.toNative(path)));
    } catch (e) {
      throw new SyncError("VaultFileNotFound", `not found: ${path}`, e);
    }
  }

  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    // ADR-0017 (accepted fallback): direct writeBinary — no absent-window the
    // watcher could misread as a deletion — plus MANDATORY read-back
    // verification. A completed-but-corrupted write fails loudly here; the
    // residual risk (hard crash mid-syscall) is documented in the ADR and is
    // never silent thanks to scan + Safe-Sync version history.
    const native = this.toNative(path);
    try {
      await this.ensureParentFolders(native);
      await this.adapter.writeBinary(native, toArrayBuffer(data));
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot write ${path}: ${String(e)}`, e);
    }
    const readBack = new Uint8Array(await this.adapter.readBinary(native));
    if (!bytesEqual(readBack, data)) {
      throw new SyncError(
        "VaultWriteFailed",
        `write verification failed for ${path}: the file on disk does not match what was written (ADR-0017)`,
      );
    }
  }

  async trash(path: VaultPath): Promise<void> {
    const native = this.toNative(path);
    try {
      if (!(await this.adapter.exists(native))) return; // idempotent
      const base = `${this.paths.syncTrash}/${path}`;
      let target = base;
      for (let attempt = 1; await this.adapter.exists(this.toNative(target)); attempt++) {
        target = `${base}.${attempt}`; // keep earlier trashed versions
      }
      const nativeTarget = this.toNative(target);
      await this.ensureParentFolders(nativeTarget);
      await this.adapter.rename(native, nativeTarget);
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot trash ${path}: ${String(e)}`, e);
    }
  }

  async delete(path: VaultPath): Promise<void> {
    try {
      const native = this.toNative(path);
      if (await this.adapter.exists(native)) await this.adapter.remove(native);
    } catch (e) {
      throw new SyncError("VaultWriteFailed", `cannot delete ${path}: ${String(e)}`, e);
    }
  }

  async stat(path: VaultPath): Promise<{ size: number; mtime: number } | null> {
    const stat = await this.adapter.stat(this.toNative(path));
    if (stat?.type !== "file") return null;
    // Sub-second precision keeps the (path,size,mtime) hash-cache key honest.
    return { size: stat.size, mtime: stat.mtime / 1000 };
  }

  toNative(path: VaultPath): string {
    return path; // Obsidian uses "/" separators on every platform
  }

  fromNative(native: string): VaultPath {
    return canonicalizePath(native); // NFD → NFC etc. (ADR-0007)
  }

  private async ensureParentFolders(native: string): Promise<void> {
    const segments = native.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (!(await this.adapter.exists(current))) {
        await this.adapter.mkdir(current);
      }
    }
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Copy: the engine may reuse buffers, and DataAdapter wants an ArrayBuffer.
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
