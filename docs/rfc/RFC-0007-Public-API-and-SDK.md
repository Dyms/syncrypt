# RFC-0007: Public API & SDK Contract

- **Status:** Accepted
- **Author(s):** Dmitriy (project author) · Architecture: Claude
- **Created:** 2026-07-16
- **Related:** RFC-0003, RFC-0004, RFC-0005, RFC-0006; ADR-0002, ADR-0006, ADR-0010

## Summary

The normative TypeScript contract for Syncrypt: the **ports** the pure core
depends on, the **domain types** (manifest, descriptors, plan, report), the
**reason codes** that make sync explainable, the **error taxonomy**, and the
**`SyncEngine`** surface the SDK exposes. This is the interface an implementer —
human or AI — builds against. Types are normative; names may be refined during
implementation but their meaning may not.

> Prime directive reminder: **Syncrypt should never surprise the user.** Every API
> that mutates state must be explainable via a `ReasonCode` and previewable via
> `dryRun`.

## Conventions

- TypeScript, `strict`. No Node-only types in `core`/`sdk` (browser + mobile safe).
- Bytes are `Uint8Array`. Times are epoch **seconds** (`number`).
- All paths are **canonical** (POSIX separators, NFC-normalized — ADR-0007).
- Everything async is `Promise`-based; long operations accept an `AbortSignal`.
- No throwing for control flow across the port boundary: ports throw only the
  typed errors in §Errors.

## 1. Domain types

```ts
/** Canonical, NFC-normalized, POSIX-separated vault-relative path. */
export type VaultPath = string;

/** Opaque storage object key (e.g. "objects/ab/cd/…", "manifests/0000042-<id>.json"). */
export type ObjectKey = string;

/** Content hash of PLAINTEXT bytes, algorithm-prefixed, e.g. "b3:9f2c…". */
export type Hash = string;

/** A stable, random per-device identifier (UUID). */
export type DeviceId = string;

/** One scanned local file. Hash is authoritative for change detection; mtime is advisory. */
export interface FileDescriptor {
  path: VaultPath;
  hash: Hash;
  size: number;   // plaintext bytes
  mtime: number;  // epoch seconds, advisory
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
  deletedAt: number;   // epoch seconds
  device: DeviceId;
}

/** The coordination document (encrypted at rest; RFC-0004 / RFC-0005). */
export interface Manifest {
  version: 1;
  generation: number;              // monotonic; the commit counter (ADR-0006)
  device: DeviceId;                // which device published this generation
  updatedAt: number;               // epoch seconds
  files: Record<VaultPath, ManifestEntry>;
  tombstones: Record<VaultPath, Tombstone>;
  /** Optional retained prior versions per path (Safe Sync, ADR-0010). */
  history?: Record<VaultPath, ManifestEntry[]>;
}
```

## 2. Ports (interfaces the pure core depends on)

The core imports **none** of the concrete adapters; the SDK injects them.

### 2.1 StoragePort

Full definition in [RFC-0006](./RFC-0006-Storage-Provider-API.md). Required subset:
`put` / `get` / `stat` / `list` / `delete` + `capabilities()`. Conditional-write
options are optional and only consulted when `capabilities().conditionalWrites`.

### 2.2 VaultPort

The local file surface a client (Obsidian, Logseq, VS Code, CLI…) implements.

```ts
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
}
```

### 2.3 CryptoPort

Encapsulates all cryptography (RFC-0005). Keeps `core` free of crypto specifics.

```ts
export interface CryptoPort {
  /** Derive the master key from a passphrase + stored KDF params (Argon2id). */
  deriveMasterKey(passphrase: string, params: KdfParams): Promise<MasterKey>;

  /** Content hash over PLAINTEXT (BLAKE3), algorithm-prefixed. */
  hash(data: Uint8Array): Promise<Hash>;

  /** Deterministic object key = HMAC(nameKey, contentHash) (RFC-0005). */
  objectKeyFor(hash: Hash): Promise<ObjectKey>;

  /** Encrypt bytes → self-describing blob (magic|ver|alg|nonce|ct|tag). */
  encrypt(role: CryptoRole, data: Uint8Array): Promise<Uint8Array>;

  /** Decrypt; rejects CryptoAuthError on tag mismatch / wrong key. */
  decrypt(role: CryptoRole, blob: Uint8Array): Promise<Uint8Array>;
}

export type CryptoRole = "content" | "manifest";
export interface KdfParams {
  kdf: "argon2id";
  salt: string;          // base64, non-secret
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  version: 1;
}
export type MasterKey = { readonly __brand: "MasterKey" }; // opaque, memory-only
```

### 2.4 ClockPort & LogPort

```ts
export interface ClockPort { now(): number; } // epoch seconds (injected for tests)

export interface LogPort {
  /** One structured, human-readable line per applied action. */
  entry(e: SyncReportEntry): void;
  info(msg: string): void;
  warn(msg: string): void;
}
```

### 2.5 StateStorePort (optional; ADR-0011)

Persists the device-local base manifest between runs. Purely a cache: if absent
or lost, the engine rebuilds by full reconcile against the remote manifest
(RFC-0004 §Local state).

```ts
export interface StateStorePort {
  /** Load the persisted engine state blob, or null if none. */
  load(): Promise<Uint8Array | null>;
  /** Persist the engine state blob (atomic where possible). */
  save(data: Uint8Array): Promise<void>;
}
```

## 3. The plan (pure output of the planner)

```ts
export type OperationKind =
  | "upload"        // local → storage
  | "download"      // storage → local
  | "delete-local"  // apply a remote deletion locally (via trash, ADR-0010)
  | "delete-remote" // propagate a local deletion (tombstone)
  | "conflict"      // both sides changed differently — never auto-merged
  | "noop";

export interface Operation {
  kind: OperationKind;
  path: VaultPath;
  reason: ReasonCode;               // the "no magic" explanation (§5)
  localHash?: Hash;
  remoteHash?: Hash;
  baseHash?: Hash;
}

export interface SyncPlan {
  /** Ordered operations. Deterministic function of (local, base, remote). */
  operations: Operation[];
  /** Set when the divergence guard fires — caller must pull first (FR-8). */
  pullFirst: boolean;
  /** Set by the Safe-Sync circuit breaker (ADR-0010) — needs confirmation. */
  requiresConfirmation: boolean;
  /** Why confirmation is required (e.g. "would delete 42 files"). */
  confirmationReason?: string;
  /** Convenience counts for UI. */
  summary: { uploads: number; downloads: number; deletions: number; conflicts: number };
}
```

The planner is pure:

```ts
export function plan(
  local: FileDescriptor[],
  base: Manifest | null,
  remote: Manifest | null,
  opts: PlanOptions,
): SyncPlan;

export interface PlanOptions {
  /** Safe-Sync bulk-change thresholds (ADR-0010, floor per ADR-0013). */
  bulkChangeFloor: number;       // default 5 — at or below: never prompt
  bulkChangeMaxFiles: number;    // default 20 — at or above: always prompt
  bulkChangeMaxFraction: number; // default 0.10 — in between: prompt if ≥ this vault fraction
}
```

## 4. The report (what actually happened)

```ts
export interface SyncReportEntry {
  path: VaultPath;
  kind: OperationKind;
  reason: ReasonCode;
  /** Rendered one-liner, e.g. "remote version is newer → downloaded". */
  message: string;
  bytes?: number;
}

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  entries: SyncReportEntry[];
  fromGeneration: number | null;
  toGeneration: number | null;
  outcome: "applied" | "pull-first" | "needs-confirmation" | "conflicts" | "no-op" | "aborted";
  conflicts: VaultPath[];
}
```

## 5. Reason codes (the vocabulary of "no magic")

Every mutation maps to exactly one. Rendering is centralized so the log,
UI, and dry-run all speak the same language.

```ts
export enum ReasonCode {
  NewLocalFile        = "new local file → uploaded",
  LocalChanged        = "local hash differs from base → uploaded",
  RemoteNewer         = "remote version is newer → downloaded",
  NewRemoteFile       = "new remote file → downloaded",
  DeletedRemotely     = "marked as deleted in manifest → removed locally",
  DeletedLocally      = "deleted locally → tombstoned remotely",
  ConflictBothChanged = "changed on both sides → conflict (not merged)",
  ConflictSamePath    = "same path created independently → conflict",
  ConflictEditDelete  = "edited on one side, deleted on the other → conflict",
  ConvergedNoop       = "already in sync → nothing to do",
}
```

## 6. Errors (typed taxonomy)

```ts
export type SyncErrorCode =
  | "StorageNotFound" | "StoragePreconditionFailed" | "StorageUnauthorized"
  | "StorageTransient" | "StorageRateLimited"
  | "VaultFileNotFound" | "VaultWriteFailed"
  | "CryptoAuthError"          // GCM tag mismatch / wrong passphrase (fail-closed)
  | "ManifestCorrupt" | "ManifestForkUnresolved"
  | "Aborted";                 // AbortSignal fired

export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode, message: string, readonly cause?: unknown) {
    super(message);
  }
}
```

Rules: `CryptoAuthError` and `ManifestCorrupt` are **fail-closed** — never apply
the affected data. `StoragePreconditionFailed` maps to `pullFirst`. `StorageTransient`
/ `StorageRateLimited` are retryable with backoff.

## 7. SyncEngine (the SDK surface)

```ts
export interface SyncEngineConfig {
  storage: StoragePort;
  vault: VaultPort;
  crypto: CryptoPort;
  clock?: ClockPort;
  log?: LogPort;
  state?: StateStorePort;        // base-manifest persistence (ADR-0011); in-memory if omitted
  deviceId: DeviceId;
  storagePrefix: string;         // bucket key prefix for this vault
  safeSync?: Partial<PlanOptions> & { versionsToKeep?: number };
  network?: {                    // resource-aware auto-sync (RFC-0004)
    wifiOnly?: boolean;
    minAutoSyncIntervalSec?: number;
    debounceSec?: number;
  };
}

export interface SyncEngine {
  /** Download remote changes; apply deletions via trash; surface conflicts. */
  pull(signal?: AbortSignal): Promise<SyncReport>;

  /** Upload local changes; publish a new generation (ADR-0006). */
  push(signal?: AbortSignal): Promise<SyncReport>;

  /** pull() then push(). The default user action. */
  sync(signal?: AbortSignal): Promise<SyncReport>;

  /** Compute and return the plan WITHOUT touching any file or object (FR-14). */
  dryRun(signal?: AbortSignal): Promise<SyncPlan>;

  /** Re-run a plan that returned requiresConfirmation, now approved by the user. */
  confirmAndApply(plan: SyncPlan, signal?: AbortSignal): Promise<SyncReport>;

  /** Current state: base generation, dirty files, last report — no I/O beyond a scan. */
  status(): Promise<SyncStatus>;
}

export interface SyncStatus {
  baseGeneration: number | null;
  dirtyFiles: number;
  lastReport?: SyncReport;
  locked: boolean;               // is a sync in progress
}

export function createSyncEngine(config: SyncEngineConfig): SyncEngine;
```

## 8. Invariants the implementation must preserve

1. `plan()` is pure and deterministic in `(local, base, remote, opts)`.
2. No operation with `kind: "conflict"` ever writes over a file.
3. `push()` publishes the manifest **last**, as an immutable generation object,
   after all content objects exist (ADR-0006).
4. `delete-local` routes through `VaultPort.trash`, never `delete` (ADR-0010).
5. Any `CryptoAuthError`/`ManifestCorrupt` aborts without applying data.
6. Every applied entry has a non-empty `ReasonCode` and `message`.
7. `requiresConfirmation` plans are never auto-applied — only via
   `confirmAndApply`.

## 9. Unresolved questions

- Exact incremental-hash cache key and its persistence (memory vs. small on-disk
  index). Base-manifest persistence is resolved by ADR-0011 (`StateStorePort`);
  the hash cache remains in-memory for M1.
- Whether `history` retention lives in the manifest (as above) or as a side index
  to keep the manifest small on very large vaults.
- Streaming API for very large attachments (chunked encrypt/put) — likely a v1.1
  addition; the `Uint8Array` shape above assumes whole-file for v1.
