// Shared internal context for the engine modules: the injected ports plus
// normalized configuration. Assembled once by createSyncEngine.

import type {
  ClockPort,
  CryptoPort,
  LogPort,
  StoragePort,
  VaultPort,
} from "../ports.js";
import type { PlanOptions } from "../plan.js";
import type { HashCache } from "../scan.js";
import type { DeviceId, ObjectKey } from "../types.js";

export interface EngineContext {
  storage: StoragePort;
  vault: VaultPort;
  crypto: CryptoPort;
  clock: ClockPort;
  log: LogPort;
  deviceId: DeviceId;
  /** Prepend the configured vault prefix to a storage-relative key. */
  key: (relative: ObjectKey) => ObjectKey;
  planOptions: PlanOptions;
  /**
   * The engine's incremental hash cache (ADR-0023), so a file we just wrote is
   * remembered with the hash we already know instead of being re-read and
   * re-hashed on the next scan. Optional: an engine without a cache works
   * identically, only slower.
   */
  hashCache?: HashCache;
  /** Safe-Sync version retention depth (ADR-0010 §3). */
  versionsToKeep: number;
  /** This client's version, recorded in what it publishes (ADR-0036). */
  clientVersion?: string;
  /** Tombstones older than this expire on push; 0 disables it (ADR-0031). */
  tombstoneGraceSeconds: number;
  /** How long an object must have been unreachable before a sweep (ADR-0030). */
  reclaimGraceSeconds: number;
  /** Manifest generations kept — reachability is computed from these (ADR-0030). */
  generationsToKeep: number;
}
