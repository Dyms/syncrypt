// keyfile-params.json — RFC-0005 §Key storage & unlock.
//
// `meta/keyfile-params.json` holds the Argon2id salt + parameters IN THE CLEAR
// (they are non-secret; only the passphrase is). It is uploaded so a new device
// needs nothing but the passphrase. Parsing fails closed; oversized params are
// rejected (see keys.ts) so a poisoned keyfile cannot OOM a device.

import {
  MANIFESTS_PREFIX,
  OBJECTS_PREFIX,
  SyncError,
  isSyncError,
  type KdfParams,
  type ObjectKey,
  type StoragePort,
} from "@syncrypt/core";

import { SyncryptCrypto } from "./crypto.js";
import { base64Encode, validateKdfParams } from "./keys.js";

export const KEYFILE_KEY: ObjectKey = "meta/keyfile-params.json";
const SALT_LENGTH = 16; // 128-bit random salt (RFC-0005)

/**
 * Argon2id parameter presets (without salt). Values chosen by benchmark —
 * see docs/security/cryptography.md §Parameters for numbers and hardware.
 */
export type KdfPreset = Omit<KdfParams, "salt">;

/**
 * Cross-device default (ADR-0018): affordable on low-end Android webviews,
 * comfortably above the ADR-0014 floor. THE default for new vaults — every
 * device the user owns must be able to run the vault's params.
 */
export const CROSS_DEVICE_KDF_PRESET: KdfPreset = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 32768, // 32 MiB
  iterations: 4,
  parallelism: 1,
};

/** Alias kept for API continuity (ADR-0018). */
export const MOBILE_KDF_PRESET: KdfPreset = CROSS_DEVICE_KDF_PRESET;

/**
 * Heavier desktop profile — EXPLICIT OPT-IN only ("desktop-only vault",
 * ADR-0018): mobile devices will refuse to join a vault created with it.
 */
export const DESKTOP_KDF_PRESET: KdfPreset = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 131072, // 128 MiB
  iterations: 3,
  parallelism: 1,
};

/** Fresh params: preset + a new random 128-bit salt. */
export function generateKdfParams(preset: KdfPreset = CROSS_DEVICE_KDF_PRESET): KdfParams {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  return { ...preset, salt: base64Encode(salt) };
}

export function serializeKdfParams(params: KdfParams): Uint8Array {
  validateKdfParams(params);
  // Stable field order; pretty-printed — this file is meant to be read by
  // humans during manual recovery.
  const json = JSON.stringify(
    {
      kdf: params.kdf,
      version: params.version,
      salt: params.salt,
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism,
    },
    null,
    2,
  );
  return new TextEncoder().encode(json + "\n");
}

export function parseKdfParams(bytes: Uint8Array): KdfParams {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new SyncError("CryptoAuthError", "keyfile-params.json is not valid JSON", e);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new SyncError("CryptoAuthError", "keyfile-params.json is not an object");
  }
  const r = raw as Record<string, unknown>;
  const params = {
    kdf: r.kdf,
    version: r.version,
    salt: r.salt,
    memoryKiB: r.memoryKiB,
    iterations: r.iterations,
    parallelism: r.parallelism,
  } as KdfParams;
  if (typeof params.salt !== "string") {
    throw new SyncError("CryptoAuthError", "keyfile-params.json has no salt");
  }
  validateKdfParams(params); // fail-closed on anything off
  return params;
}

export interface OpenVaultCryptoOptions {
  storage: StoragePort;
  /** Same prefix the SyncEngine is configured with. */
  storagePrefix: string;
  passphrase: string;
  /** Preset used only when the vault has no keyfile yet (first device).
   *  Default: CROSS_DEVICE_KDF_PRESET (ADR-0018). */
  defaults?: KdfPreset;
  /**
   * Device affordability ceiling (ADR-0018). Vault params above it are
   * refused FAIL-CLOSED instead of OOM-crashing a webview. Mobile clients
   * pass { maxMemoryKiB: 131072 }.
   */
  affordability?: { maxMemoryKiB: number };
}

/**
 * Load-or-create the vault's KDF params, then derive the key ring.
 *
 * Two fresh devices may race to create different salts; the stored file is
 * authoritative: we PUT with create-if-absent where supported, then GET back
 * and derive from whatever actually won.
 *
 * Creating it is the dangerous half. `meta/keyfile-params.json` is the only
 * copy of the Argon2id salt, and every byte in the vault was encrypted under
 * a key derived from it: overwrite it and the data is not lost-and-restorable,
 * it is unreadable for ever, by every device, with the correct passphrase in
 * hand. A backend without conditional writes cannot refuse the overwrite for
 * us — WebDAV declares `conditionalWrites: false` by design — so "the file was
 * not there" must be established, not assumed from one answer. ADR-0039: the
 * server is untrusted input, and a spurious 404 is a thing servers and proxies
 * do. Hence two gates before a create: ask twice, and refuse outright if the
 * vault already holds anything that only the missing salt could decrypt.
 */
export async function openVaultCrypto(
  opts: OpenVaultCryptoOptions,
): Promise<SyncryptCrypto> {
  const prefix = opts.storagePrefix.replace(/\/+$/, "");
  const key = prefix === "" ? KEYFILE_KEY : `${prefix}/${KEYFILE_KEY}`;
  const { storage } = opts;

  let stored: Uint8Array | null = null;
  try {
    stored = await storage.get(key);
  } catch (e) {
    if (!isSyncError(e, "StorageNotFound")) throw e;
  }

  // Gate 1. One more read before believing it is not there. A single dropped
  // or lied-about 404 costs one extra request here — and the whole vault if we
  // skip it.
  stored ??= await tryGet(storage, key);

  if (stored === null) {
    // Gate 2. A vault that holds ciphertext holds the keyfile that made it
    // readable — the protocol produces no other state. "Data, but no salt" is
    // therefore never a vault to initialize; it is a listing that lied, a
    // prefix typed wrong, a bucket pointed at by mistake, or the salt already
    // gone. Creating a fresh salt over any of those is the one mistake with
    // no way back, so this refuses instead, and says which it is.
    await refuseIfVaultHasContent(storage, prefix);

    const preset = opts.defaults ?? CROSS_DEVICE_KDF_PRESET;
    // The creation guard too: never create a vault THIS device cannot unlock.
    assertAffordable(preset.memoryKiB, opts.affordability);
    const fresh = serializeKdfParams(generateKdfParams(preset));
    try {
      await storage.put(
        key,
        fresh,
        storage.capabilities().conditionalWrites
          ? { ifNoneMatch: "*", contentType: "application/json" }
          : { contentType: "application/json" },
      );
    } catch (e) {
      // Another device created it first — theirs wins.
      if (!isSyncError(e, "StoragePreconditionFailed")) throw e;
    }
    stored = await storage.get(key); // authoritative read-back
  }

  const params = parseKdfParams(stored);
  // ADR-0018: joining always uses the VAULT's params — but if they exceed
  // what this device can afford, refuse with an actionable message instead
  // of letting Argon2id OOM the webview.
  assertAffordable(params.memoryKiB, opts.affordability);
  return SyncryptCrypto.create(opts.passphrase, params);
}

/** GET that answers null for "not there" and rethrows everything else. */
async function tryGet(storage: StoragePort, key: ObjectKey): Promise<Uint8Array | null> {
  try {
    return await storage.get(key);
  } catch (e) {
    if (isSyncError(e, "StorageNotFound")) return null;
    throw e;
  }
}

/** The first key under a prefix, or null. Stops after one — this is a probe. */
async function firstKeyUnder(storage: StoragePort, prefix: string): Promise<ObjectKey | null> {
  for await (const stat of storage.list(prefix)) return stat.key;
  return null;
}

/**
 * Refuse to create a salt for a vault that already has data under it.
 *
 * A LIST that cannot answer is NOT taken as "empty": the error propagates.
 * Being unable to prove the vault empty is exactly the state in which
 * creating a new salt must not happen, and every sync lists these prefixes
 * anyway, so a storage that cannot list is not a storage this vault works on.
 */
async function refuseIfVaultHasContent(storage: StoragePort, prefix: string): Promise<void> {
  const at = (relative: string): string =>
    prefix === "" ? relative : `${prefix}/${relative}`;
  for (const [what, where] of [
    ["manifest", at(MANIFESTS_PREFIX)],
    ["encrypted object", at(OBJECTS_PREFIX)],
  ] as const) {
    const found = await firstKeyUnder(storage, where);
    if (found === null) continue;
    throw new SyncError(
      "VaultKeyfileMissing",
      `refusing to create a new vault key: "${at(KEYFILE_KEY)}" is missing, but the ` +
        `storage already holds at least one ${what} ("${found}"). Writing a new Argon2id ` +
        `salt here would make everything already stored permanently unreadable. Check the ` +
        `endpoint, bucket and prefix in settings; if they are right, restore ` +
        `${KEYFILE_KEY} from a backup before syncing.`,
    );
  }
}

function assertAffordable(
  memoryKiB: number,
  affordability?: { maxMemoryKiB: number },
): void {
  if (affordability !== undefined && memoryKiB > affordability.maxMemoryKiB) {
    throw new SyncError(
      "CryptoAuthError",
      `this vault's KDF needs ${Math.round(memoryKiB / 1024)} MiB of Argon2id memory, ` +
        `above this device's ${Math.round(affordability.maxMemoryKiB / 1024)} MiB budget ` +
        `(ADR-0018). Unlock it on a desktop, or recreate the vault with the ` +
        `cross-device profile.`,
    );
  }
}
