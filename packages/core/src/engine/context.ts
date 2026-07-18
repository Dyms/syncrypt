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
  /** Safe-Sync version retention depth (ADR-0010 §3). */
  versionsToKeep: number;
}
