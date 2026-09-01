// Ports — the interfaces the pure core depends on (RFC-0007 §2, RFC-0006).
// The core imports NONE of the concrete adapters; the SDK injects them.

import type { Hash, ObjectKey, VaultPath } from "./types.js";
import type { SyncOutcome, SyncReportEntry } from "./report.js";
import type { ConfirmationReason, PacingDiscount } from "./plan.js";

// ---------------------------------------------------------------------------
// StoragePort (RFC-0006). "StorageProvider" in RFC-0006 is the same contract.
// ---------------------------------------------------------------------------

export interface ObjectStat {
  key: ObjectKey;
  size: number;
  /** Provider-native version/etag token used for conditional writes. */
  etag: string;
  lastModified: number; // epoch seconds, advisory
}

export interface PutOptions {
  /** Succeed only if the current object's etag matches (compare-and-swap). */
  ifMatch?: string;
  /** Succeed only if the object does not exist (create-if-absent). */
  ifNoneMatch?: "*";
  contentType?: string;
}

export interface PutResult {
  etag: string;
}

export interface ProviderCapabilities {
  /** True if put() honors ifMatch/ifNoneMatch atomically. */
  conditionalWrites: boolean;
  /** True if the backend keeps prior object versions (bucket versioning). */
  objectVersioning: boolean;
  /** Max single-PUT size before multipart is required, in bytes. */
  maxSinglePutBytes: number;
}

export interface StoragePort {
  /** Upload bytes. With ifMatch/ifNoneMatch, performs a conditional write
   *  (only consulted when capabilities().conditionalWrites). */
  put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult>;

  /** Download bytes. Rejects with SyncError("StorageNotFound") if absent. */
  get(key: ObjectKey): Promise<Uint8Array>;

  /** Metadata without downloading the body. Rejects StorageNotFound if absent. */
  stat(key: ObjectKey): Promise<ObjectStat>;

  /** List keys under a prefix (paginated by the provider). */
  list(prefix: string): AsyncIterable<ObjectStat>;

  /** Delete an object. Idempotent: deleting a missing key is not an error. */
  delete(key: ObjectKey): Promise<void>;

  /** Provider capabilities so the engine can adapt. */
  capabilities(): ProviderCapabilities;
}

/** RFC-0006 names this StorageProvider; the engine-side name is StoragePort. */
export type StorageProvider = StoragePort;

// ---------------------------------------------------------------------------
// VaultPort (RFC-0007 §2.2) — the local file surface a client implements.
// ---------------------------------------------------------------------------

export interface VaultPort {
  /** List files matching the active profile. Returns canonical paths. */
  list(): AsyncIterable<VaultPath>;

  /** Read plaintext bytes of a file. Rejects VaultFileNotFound if missing. */
  read(path: VaultPath): Promise<Uint8Array>;

  /** Create/overwrite a file atomically (temp + rename where possible). */
  write(path: VaultPath, data: Uint8Array): Promise<void>;

  /** Move a file into local Safe-Sync trash instead of hard-deleting (ADR-0010). */
  trash(path: VaultPath): Promise<void>;

  /** Hard-delete (used only by GC of the trash itself). */
  delete(path: VaultPath): Promise<void>;

  /** Cheap metadata for incremental hashing (size+mtime cache key). */
  stat(path: VaultPath): Promise<{ size: number; mtime: number } | null>;

  /** Map canonical ↔ platform-native path (NFD/NFC, case) — ADR-0007. */
  toNative(path: VaultPath): string;
  fromNative(native: string): VaultPath;

  /**
   * Does THIS device's profile cover this path? (ADR-0022)
   *
   * `list()` only reports files the profile covers, which leaves the engine
   * unable to tell "the user deleted it" from "this device does not sync that
   * kind of file". Without this predicate a device with a narrower profile
   * reads every out-of-profile file in the manifest as a local deletion and
   * tombstones it FOR EVERY DEVICE — silent data loss on the machines that do
   * sync those files.
   *
   * Paths that answer false are simply not this device's business: never
   * downloaded here, never reported as deleted here, left untouched in the
   * manifest for the devices that do carry them.
   *
   * Optional: implementations without a profile (tests, headless tools) sync
   * everything they list, and the engine defaults to true.
   */
  syncable?(path: VaultPath): boolean;
}

// ---------------------------------------------------------------------------
// CryptoPort (RFC-0007 §2.3) — all cryptography behind one port (RFC-0005).
// ---------------------------------------------------------------------------

export type CryptoRole = "content" | "manifest";

export interface KdfParams {
  kdf: "argon2id";
  salt: string; // base64, non-secret
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  version: 1;
}

export interface CryptoPort {
  // NOTE: there is deliberately no deriveMasterKey() here (ADR-0028). The
  // master key never leaves the crypto implementation: it is derived, turned
  // into the three role subkeys, and zeroized in the same call. A port method
  // handing it back would be the one way to keep raw key material alive in a
  // caller's memory — and nothing ever needed it.

  /** Content hash over PLAINTEXT (BLAKE3), algorithm-prefixed. */
  hash(data: Uint8Array): Promise<Hash>;

  /** Deterministic object key = HMAC(nameKey, contentHash) (RFC-0005). */
  objectKeyFor(hash: Hash): Promise<ObjectKey>;

  /** Encrypt bytes → self-describing blob (magic|ver|alg|nonce|ct|tag). */
  encrypt(role: CryptoRole, data: Uint8Array): Promise<Uint8Array>;

  /** Decrypt; rejects SyncError("CryptoAuthError") on tag mismatch / wrong key. */
  decrypt(role: CryptoRole, blob: Uint8Array): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// ClockPort, LogPort (RFC-0007 §2.4), StateStorePort (§2.5, ADR-0011).
// ---------------------------------------------------------------------------

export interface ClockPort {
  now(): number; // epoch seconds (injected for deterministic tests)
}

/**
 * Something the engine has to say that is not about one file (ADR-0026).
 *
 * A code plus its facts, never a sentence: the engine does not know what
 * language the reader speaks, and a string it invents cannot be translated
 * afterwards. `detail` fields carry a technical cause (an exception message)
 * that stays as it is in every language.
 */
export type EngineNotice =
  | { code: "sync-outcome"; outcome: SyncOutcome }
  | { code: "pull-first" }
  | { code: "confirmation-required"; reason?: ConfirmationReason }
  | { code: "confirmation-stale"; newDestructive: number }
  | { code: "state-unreadable"; detail: string }
  | { code: "dedup-probe-unavailable"; path: VaultPath; detail: string }
  | { code: "manifest-entries-forgotten"; count: number; generation: number }
  | { code: "deletions-paced"; discount: PacingDiscount }
  | { code: "tombstones-expired"; count: number; graceSeconds: number }
  | { code: "fork-lost"; generation: number }
  | {
      code: "storage-reclaimed";
      deleted: number;
      bytesFreed: number;
      prunedManifests: number;
      waiting: number;
    };

export interface LogPort {
  /** One applied action, as data (path + reason code + detail). */
  entry(e: SyncReportEntry): void;
  /** Everything else the engine reports. Also data — see EngineNotice. */
  notice(n: EngineNotice): void;
}

/** Persists the device-local base manifest between runs (a cache — ADR-0011). */
export interface StateStorePort {
  /** Load the persisted engine state blob, or null if none. */
  load(): Promise<Uint8Array | null>;
  /** Persist the engine state blob (atomic where possible). */
  save(data: Uint8Array): Promise<void>;
}
