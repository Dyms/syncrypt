// Key hierarchy — RFC-0005 §Key hierarchy.
//
//   passphrase --Argon2id(salt, params)--> Master Key (32 bytes)
//     ├─ HKDF-SHA256("syncrypt/content")  → Content Key  (AES-256-GCM)
//     ├─ HKDF-SHA256("syncrypt/manifest") → Manifest Key (AES-256-GCM)
//     └─ HKDF-SHA256("syncrypt/names")    → Name Key     (keyed BLAKE3)
//
// HKDF uses an EMPTY salt (per RFC 5869 that equals a zero-filled salt of hash
// length — matching `salt=None` in Python's `cryptography`, see the manual
// recovery script). Keys are memory-only: never logged, never persisted;
// intermediate raw bytes are zeroized best-effort.

import { argon2id } from "hash-wasm";

import { SyncError, type KdfParams } from "@syncrypt/core";

export const MASTER_KEY_LENGTH = 32;
export const SUBKEY_LENGTH = 32;

export const HKDF_INFO_CONTENT = "syncrypt/content";
export const HKDF_INFO_MANIFEST = "syncrypt/manifest";
export const HKDF_INFO_NAMES = "syncrypt/names";

/** Best-effort zeroization (the platform may still hold copies). */
export function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Upper bounds guard against a poisoned keyfile-params.json (an attacker with
 * bucket write access must not be able to OOM/hang a device via huge KDF
 * params). Derivation fails closed instead.
 */
const MAX_MEMORY_KIB = 1024 * 1024; // 1 GiB
const MAX_ITERATIONS = 100;
const MAX_PARALLELISM = 16;

export function validateKdfParams(params: KdfParams): void {
  const bad = (detail: string): SyncError =>
    new SyncError("CryptoAuthError", `invalid KDF params: ${detail} — refusing to derive`);
  // Runtime defense: params often arrive from parsed JSON, so the static
  // types lie — compare through `unknown` on purpose.
  const kdf: unknown = params.kdf;
  const version: unknown = params.version;
  if (kdf !== "argon2id") throw bad(`unsupported kdf "${String(kdf)}"`);
  if (version !== 1) throw bad(`unsupported version ${String(version)}`);
  if (
    !Number.isInteger(params.parallelism) ||
    params.parallelism < 1 ||
    params.parallelism > MAX_PARALLELISM
  ) {
    throw bad(`parallelism ${String(params.parallelism)}`);
  }
  if (
    !Number.isInteger(params.iterations) ||
    params.iterations < 1 ||
    params.iterations > MAX_ITERATIONS
  ) {
    throw bad(`iterations ${String(params.iterations)}`);
  }
  if (
    !Number.isInteger(params.memoryKiB) ||
    params.memoryKiB < 8 * params.parallelism ||
    params.memoryKiB > MAX_MEMORY_KIB
  ) {
    throw bad(`memoryKiB ${String(params.memoryKiB)}`);
  }
  let salt: Uint8Array;
  try {
    salt = base64Decode(params.salt);
  } catch {
    throw bad("salt is not valid base64");
  }
  if (salt.length < 8 || salt.length > 64) throw bad(`salt length ${salt.length}`);
}

/** Argon2id(passphrase, salt, params) → 32-byte Master Key. */
export async function deriveMasterKeyBytes(
  passphrase: string,
  params: KdfParams,
): Promise<Uint8Array> {
  validateKdfParams(params);
  const salt = base64Decode(params.salt);
  const mk = await argon2id({
    password: passphrase,
    salt,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: MASTER_KEY_LENGTH,
    outputType: "binary",
  });
  return mk;
}

export interface KeyRing {
  /** AES-256-GCM key for file objects (non-extractable WebCrypto key). */
  contentKey: CryptoKey;
  /** AES-256-GCM key for the manifest (non-extractable WebCrypto key). */
  manifestKey: CryptoKey;
  /** Raw 32-byte key for keyed-BLAKE3 object names (needed as raw bytes). */
  nameKey: Uint8Array;
}

async function hkdfSubkey(hkdfKey: CryptoKey, info: string): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    SUBKEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Derive the three role subkeys. Does NOT zeroize the master key (caller's job). */
export async function deriveKeyRing(masterKey: Uint8Array): Promise<KeyRing> {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new SyncError("CryptoAuthError", "invalid master key length");
  }
  const hkdfKey = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, [
    "deriveBits",
  ]);
  const contentRaw = await hkdfSubkey(hkdfKey, HKDF_INFO_CONTENT);
  const manifestRaw = await hkdfSubkey(hkdfKey, HKDF_INFO_MANIFEST);
  const nameKey = await hkdfSubkey(hkdfKey, HKDF_INFO_NAMES);
  const contentKey = await importAesKey(contentRaw);
  const manifestKey = await importAesKey(manifestRaw);
  zeroize(contentRaw);
  zeroize(manifestRaw);
  return { contentKey, manifestKey, nameKey };
}
