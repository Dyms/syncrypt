// @syncrypt/sdk — the public facade (RFC-0003 §sdk, RFC-0007 §7).
//
// One call turns (storage, vault, passphrase) into a ready SyncEngine:
// openVaultCrypto bootstraps/loads meta/keyfile-params.json and derives the
// key ring; createSyncEngine wires the ports. Contains NO logic of its own
// and no Node-only APIs — safe for desktop, browser, and mobile clients.

import {
  createSyncEngine,
  isSyncError,
  type ClockPort,
  type DeviceId,
  type LogPort,
  type SafeSyncOptions,
  type StateStorePort,
  type StoragePort,
  type SyncEngine,
  type VaultPort,
} from "@syncrypt/core";
import { openVaultCrypto, legacyPassphraseForms, type KdfPreset } from "@syncrypt/crypto";
import type { PassphraseForm } from "@syncrypt/crypto";

export interface OpenSyncEngineOptions {
  storage: StoragePort;
  vault: VaultPort;
  /** The user's passphrase — held only for the duration of key derivation. */
  passphrase: string;
  deviceId: DeviceId;
  /** This client's version, recorded in what it publishes (ADR-0036). */
  clientVersion?: string;
  /** Bucket key prefix for this vault (default: bucket root). */
  storagePrefix?: string;
  clock?: ClockPort;
  log?: LogPort;
  state?: StateStorePort;
  /** Every safe-sync knob the engine accepts — one named type (ADR-0060). */
  safeSync?: SafeSyncOptions;
  /** KDF preset used only when this vault has no keyfile yet (first device). */
  kdfDefaults?: KdfPreset;
  /** Device KDF affordability ceiling (ADR-0018) — mobile clients pass it. */
  affordability?: { maxMemoryKiB: number };
  /**
   * May an empty location become a new vault? Default true. Interactive
   * clients pass false and ask the person first; an empty location then
   * rejects `VaultAbsent` (ADR-0065).
   */
  createVault?: boolean;
}

/**
 * Bootstrap the vault's crypto from the passphrase (creating
 * meta/keyfile-params.json on the first device) and return a ready engine.
 * Wrong passphrase on an existing vault surfaces as CryptoAuthError on the
 * first pull/push — fail-closed, nothing applied.
 *
 * A passphrase that can be typed as more than one byte string gets one extra
 * step (ADR-0057): the NFC engine is asked to prove itself with
 * `verifyAccess()`, and only if the vault refuses it are the legacy forms
 * tried. For ASCII — and for any passphrase already in NFC — there is one
 * candidate, and this is exactly the old path with no extra request.
 */
export async function openSyncEngine(opts: OpenSyncEngineOptions): Promise<SyncEngine> {
  const storagePrefix = opts.storagePrefix ?? "";
  const legacyForms = legacyPassphraseForms(opts.passphrase);
  const build = async (form: PassphraseForm): Promise<SyncEngine> =>
    engineWith(
      opts,
      storagePrefix,
      await openVaultCrypto({
        storage: opts.storage,
        storagePrefix,
        passphrase: opts.passphrase,
        passphraseForm: form,
        ...(opts.kdfDefaults !== undefined ? { defaults: opts.kdfDefaults } : {}),
        ...(opts.affordability !== undefined ? { affordability: opts.affordability } : {}),
        ...(opts.createVault !== undefined ? { create: opts.createVault } : {}),
      }),
    );

  const spec = await build("nfc");
  if (legacyForms.length === 0) return spec;

  try {
    await spec.verifyAccess();
    return spec; // the vault agrees with the spec, or has nothing to say yet
  } catch (e) {
    // Only "these keys do not open this vault" is a reason to try another
    // form. An unreachable bucket is not, and must surface as itself.
    if (!isSyncError(e, "CryptoAuthError")) throw e;
  }

  for (const form of legacyForms) {
    const legacy = await build(form);
    try {
      await legacy.verifyAccess();
    } catch (e) {
      if (!isSyncError(e, "CryptoAuthError")) throw e;
      continue;
    }
    // It opened. Say so: this vault predates ADR-0057 and its passphrase is
    // not the string the spec would derive from, which is worth knowing before
    // the next client is written.
    opts.log?.notice({ code: "passphrase-legacy-form", form });
    return legacy;
  }
  // Nothing opened it. Hand back the spec engine so the failure the caller
  // sees is the ordinary wrong-passphrase one, from the ordinary code path.
  return spec;
}

function engineWith(
  opts: OpenSyncEngineOptions,
  storagePrefix: string,
  crypto: Awaited<ReturnType<typeof openVaultCrypto>>,
): SyncEngine {
  return createSyncEngine({
    storage: opts.storage,
    vault: opts.vault,
    crypto,
    deviceId: opts.deviceId,
    storagePrefix,
    // The base is tied to the vault it came from (ADR-0079).
    vaultIdentity: crypto.vaultIdentity,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.safeSync !== undefined ? { safeSync: opts.safeSync } : {}),
    ...(opts.clientVersion !== undefined ? { clientVersion: opts.clientVersion } : {}),
  });
}

// The full engine surface, re-exported so clients need one dependency.
export * from "@syncrypt/core";
export {
  CROSS_DEVICE_KDF_PRESET,
  MOBILE_MEMORY_BUDGET_KIB,
  DESKTOP_KDF_PRESET,
  MOBILE_KDF_PRESET,
  SyncryptCrypto,
  openVaultCrypto,
  keyfilePathFor,
  vaultHasKeyfile,
  legacyPassphraseForms,
  type KdfPreset,
  type LegacyPassphraseForm,
  type PassphraseForm,
} from "@syncrypt/crypto";
