// Shared fixture builders for core tests.

import type {
  DeviceId,
  FileDescriptor,
  Hash,
  Manifest,
  ManifestEntry,
  VaultPath,
} from "../src/index.js";

export function entry(hash: Hash, mtime = 1000): ManifestEntry {
  return { hash, size: 1, mtime, objectKey: `objects/${hash.replace(":", "-")}` };
}

export function manifest(opts: {
  generation?: number;
  device?: DeviceId;
  files?: Record<VaultPath, Hash>;
  tombstones?: VaultPath[];
}): Manifest {
  const files: Record<VaultPath, ManifestEntry> = {};
  for (const [path, hash] of Object.entries(opts.files ?? {})) {
    files[path] = entry(hash);
  }
  const tombstones: Manifest["tombstones"] = {};
  for (const path of opts.tombstones ?? []) {
    tombstones[path] = { deletedAt: 900, device: opts.device ?? "dev-1" };
  }
  return {
    version: 1,
    generation: opts.generation ?? 1,
    device: opts.device ?? "dev-1",
    updatedAt: 1000,
    files,
    tombstones,
  };
}

export function localFiles(
  files: Record<VaultPath, Hash>,
  mtime = 1000,
): FileDescriptor[] {
  return Object.entries(files).map(([path, hash]) => ({
    path,
    hash,
    size: 1,
    mtime,
  }));
}
