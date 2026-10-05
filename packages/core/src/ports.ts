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

  /**
   * Metadata without downloading the body. Rejects StorageNotFound if absent.
   *
   * `key` of the result is the key that was asked for, and `etag` is NEVER
   * empty — a zero-byte object has one like any other, because conditional
   * writes compare against it (ADR-0056).
   */
  stat(key: ObjectKey): Promise<ObjectStat>;

  /**
   * List keys under a prefix, paginated by the provider — a KEY prefix, not a
   * path prefix: `list("a")` includes `ab/1`, `list("a/")` does not.
   *
   * The contract, because callers depend on all four and a provider that
   * breaks one is not visibly broken (RFC-0006 §Conformance, ADR-0058):
   *
   * 1. **Only keys under `prefix`.** Callers slice the prefix off what they
   *    get (`listObjects`), so a key from somewhere else does not arrive as a
   *    foreign key — it arrives as a plausible one, pointing at an object that
   *    is not there. A backend that answers with more than it was asked for is
   *    the server talking (ADR-0039, ADR-0052): the provider drops it.
   * 2. **Every key is complete and validated.** `stat.key` is the whole key,
   *    not a suffix, and it has been through the same check as a key being
   *    written: no `.`/`..` segment, no empty segment, no leading slash
   *    (ADR-0044). It goes straight back into `get`/`stat`/`delete`.
   * 3. **The whole listing, or an error.** A provider may not end a paginated
   *    walk early and have it look complete; a truncated page with no
   *    continuation is a protocol violation, not an empty remainder
   *    (ADR-0052). An under-reported `manifests/` listing reads as a LOWER
   *    generation, which is an ADR-0038 refusal for ever on a device with a
   *    base and an empty vault on one without.
   * 4. **Never StorageNotFound.** A walk is a snapshot attempt. Another
   *    device deleting an object while this one lists is ordinary, and the
   *    object is simply not in the result — reporting "not found" for the
   *    listing fails `readRemote` and reclamation over a key nobody asked
   *    about. Every other Storage* error still propagates.
   */
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
  /**
   * List files matching the active profile, as canonical paths.
   *
   * Canonicalization is not injective (ADR-0007): two native names can arrive
   * here as one path, and the vault index has room for one of them. The
   * engine detects that and syncs neither, rather than picking one silently
   * (ADR-0053) — but an implementation that can map back losslessly should,
   * because a path excluded that way is a file the user is not backing up.
   */
  list(): AsyncIterable<VaultPath>;

  /**
   * Read plaintext bytes of a file. Rejects VaultFileNotFound if — and ONLY
   * if — the file is not there: the scan turns that answer into a deletion
   * for every device. Any other failure (permission, lock, I/O, a cloud
   * placeholder that cannot be fetched) must reject with another code, so the
   * sync fails instead of publishing a tombstone (ADR-0054 §4, ADR-0062).
   */
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
  | { code: "forgotten-objects-released"; count: number; generation: number }
  | { code: "deletions-paced"; discount: PacingDiscount }
  | { code: "tombstones-expired"; count: number; graceSeconds: number }
  | { code: "fork-lost"; generation: number }
  | { code: "storage-rolled-back"; remote: number; base: number }
  | { code: "vault-written-by-newer"; writer: string; self: string }
  | { code: "vault-written-by-older"; writer: string | undefined; self: string }
  | { code: "paths-not-distinct"; paths: VaultPath[] }
  | { code: "paths-unreadable"; paths: VaultPath[] }
  | { code: "paths-changed-during-sync"; paths: VaultPath[] }
  | { code: "passphrase-legacy-form"; form: "as-typed" | "nfd" }
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
