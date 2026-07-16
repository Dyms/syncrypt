// keyfile-params.json — RFC-0005 §Key storage & unlock.
//
// `meta/keyfile-params.json` holds the Argon2id salt + parameters IN THE CLEAR
// (they are non-secret; only the passphrase is). It is uploaded so a new device
// needs nothing but the passphrase. Parsing fails closed; oversized params are
// rejected (see keys.ts) so a poisoned keyfile cannot OOM a device.

import {
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

/** Desktop default: ~0.5–1 s unlock on a mid-range 2020s laptop. */
export const DESKTOP_KDF_PRESET: KdfPreset = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 65536, // 64 MiB
  iterations: 3,
  parallelism: 1,
};

/** Mobile profile: lower memory for webview limits; more passes to compensate. */
export const MOBILE_KDF_PRESET: KdfPreset = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 32768, // 32 MiB
  iterations: 4,
  parallelism: 1,
};

/** Fresh params: preset + a new random 128-bit salt. */
export function generateKdfParams(preset: KdfPreset = DESKTOP_KDF_PRESET): KdfParams {
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
  /** Preset used only when the vault has no keyfile yet (first device). */
  defaults?: KdfPreset;
}

/**
 * Load-or-create the vault's KDF params, then derive the key ring.
 *
 * Two fresh devices may race to create different salts; the stored file is
 * authoritative: we PUT with create-if-absent where supported, then GET back
 * and derive from whatever actually won. Divergence is thereby impossible
 * (worst case on a last-writer-wins backend: one device re-derives).
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

  if (stored === null) {
    const fresh = serializeKdfParams(generateKdfParams(opts.defaults));
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

  return SyncryptCrypto.create(opts.passphrase, parseKdfParams(stored));
}
