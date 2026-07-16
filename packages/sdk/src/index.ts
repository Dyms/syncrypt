// @syncrypt/sdk — the public facade (RFC-0003 §sdk, RFC-0007 §7).
//
// One call turns (storage, vault, passphrase) into a ready SyncEngine:
// openVaultCrypto bootstraps/loads meta/keyfile-params.json and derives the
// key ring; createSyncEngine wires the ports. Contains NO logic of its own
// and no Node-only APIs — safe for desktop, browser, and mobile clients.

import {
  createSyncEngine,
  type ClockPort,
  type DeviceId,
  type LogPort,
  type PlanOptions,
  type StateStorePort,
  type StoragePort,
  type SyncEngine,
  type VaultPort,
} from "@syncrypt/core";
import { openVaultCrypto, type KdfPreset } from "@syncrypt/crypto";

export interface OpenSyncEngineOptions {
  storage: StoragePort;
  vault: VaultPort;
  /** The user's passphrase — held only for the duration of key derivation. */
  passphrase: string;
  deviceId: DeviceId;
  /** Bucket key prefix for this vault (default: bucket root). */
  storagePrefix?: string;
  clock?: ClockPort;
  log?: LogPort;
  state?: StateStorePort;
  safeSync?: Partial<PlanOptions> & { versionsToKeep?: number };
  /** KDF preset used only when this vault has no keyfile yet (first device). */
  kdfDefaults?: KdfPreset;
}

/**
 * Bootstrap the vault's crypto from the passphrase (creating
 * meta/keyfile-params.json on the first device) and return a ready engine.
 * Wrong passphrase on an existing vault surfaces as CryptoAuthError on the
 * first pull/push — fail-closed, nothing applied.
 */
export async function openSyncEngine(opts: OpenSyncEngineOptions): Promise<SyncEngine> {
  const storagePrefix = opts.storagePrefix ?? "";
  const crypto = await openVaultCrypto({
    storage: opts.storage,
    storagePrefix,
    passphrase: opts.passphrase,
    ...(opts.kdfDefaults !== undefined ? { defaults: opts.kdfDefaults } : {}),
  });
  return createSyncEngine({
    storage: opts.storage,
    vault: opts.vault,
    crypto,
    deviceId: opts.deviceId,
    storagePrefix,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.safeSync !== undefined ? { safeSync: opts.safeSync } : {}),
  });
}

// The full engine surface, re-exported so clients need one dependency.
export * from "@syncrypt/core";
export {
  DESKTOP_KDF_PRESET,
  MOBILE_KDF_PRESET,
  SyncryptCrypto,
  openVaultCrypto,
  type KdfPreset,
} from "@syncrypt/crypto";
