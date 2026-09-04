// Domain types — RFC-0007 §1. Normative; meanings must not drift.

/** Canonical, NFC-normalized, POSIX-separated vault-relative path. */
export type VaultPath = string;

/** Opaque storage object key (e.g. "objects/ab/cd/…", "manifests/000000042-<id>.json"). */
export type ObjectKey = string;

/** Content hash of PLAINTEXT bytes, algorithm-prefixed, e.g. "b3:9f2c…". */
export type Hash = string;

/** A stable, random per-device identifier (UUID). */
export type DeviceId = string;

/** One scanned local file. Hash is authoritative for change detection; mtime is advisory. */
export interface FileDescriptor {
  path: VaultPath;
  hash: Hash;
  size: number; // plaintext bytes
  mtime: number; // epoch seconds, advisory
}

/** A manifest entry for a live file. */
export interface ManifestEntry {
  hash: Hash;
  size: number;
  mtime: number;
  /** Storage object holding this version's ciphertext (RFC-0005 object key). */
  objectKey: ObjectKey;
}

/** A record that a path was deleted. */
export interface Tombstone {
  deletedAt: number; // epoch seconds
  device: DeviceId;
}

/** The coordination document (encrypted at rest; RFC-0004 / RFC-0005). */
export interface Manifest {
  version: 1;
  generation: number; // monotonic; the commit counter (ADR-0006)
  device: DeviceId; // which device published this generation
  updatedAt: number; // epoch seconds
  files: Record<VaultPath, ManifestEntry>;
  tombstones: Record<VaultPath, Tombstone>;
  /** Optional retained prior versions per path (Safe Sync, ADR-0010). */
  history?: Record<VaultPath, ManifestEntry[]>;
  /**
   * Which client version published this generation (ADR-0036). Absent on
   * manifests written before this was recorded — which is itself the signal
   * that a client predating it is still writing to this vault.
   */
  writer?: string;
  /**
   * Object keys kept alive for entries the user FORGOT (ADR-0027, ADR-0055).
   *
   * Forgetting removes a path from `files`, which is what makes the manifest
   * smaller — and used to make its ciphertext unreferenced, so the next
   * reclamation deleted it. For an entry no device carries any more, storage
   * was the only copy. These keys are reachable for reclamation exactly so
   * that is not true: what a forgotten entry costs is a key here, not a file.
   * Deleting them is `releaseForgotten()`, which is its own deliberate act.
   */
  forgotten?: ObjectKey[];
}
