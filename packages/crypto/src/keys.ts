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
/** Ticket keys are a SEPARATE purpose from vault keys — ADR-0028. */
export const HKDF_INFO_TICKET = "syncrypt/ticket";

/** Best-effort zeroization (the platform may still hold copies). */
export function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Type-only narrowing for WebCrypto call sites: current DOM lib types demand
 * ArrayBuffer-backed views (`Uint8Array<ArrayBuffer>`). Nothing in this
 * package ever allocates from a SharedArrayBuffer, so the assertion is sound
 * and costs no copy.
 */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
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
 * Bounds guard against a poisoned keyfile-params.json (threat-model A3 has
 * bucket write access; the keyfile is stored in the clear, unauthenticated).
 * Upper bounds: huge params must not OOM/hang a device.
 * Lower FLOOR (ADR-0014, anti-downgrade): a seeded weak keyfile must not make
 * a fresh vault cheap to brute-force offline. Floor = the OWASP reference
 * minimum for Argon2id. Derivation fails closed either way.
 */
const MAX_MEMORY_KIB = 1024 * 1024; // 1 GiB
const MAX_ITERATIONS = 100;
const MAX_PARALLELISM = 16;
export const MIN_MEMORY_KIB = 19456; // 19 MiB — OWASP Argon2id reference minimum
export const MIN_ITERATIONS = 2;
export const MIN_PARALLELISM = 1;

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
    params.parallelism < MIN_PARALLELISM ||
    params.parallelism > MAX_PARALLELISM
  ) {
    throw bad(`parallelism ${String(params.parallelism)}`);
  }
  if (
    !Number.isInteger(params.iterations) ||
    params.iterations < MIN_ITERATIONS ||
    params.iterations > MAX_ITERATIONS
  ) {
    throw bad(
      `iterations ${String(params.iterations)} (below the ADR-0014 floor or above the anti-DoS cap)`,
    );
  }
  if (
    !Number.isInteger(params.memoryKiB) ||
    params.memoryKiB < MIN_MEMORY_KIB ||
    params.memoryKiB > MAX_MEMORY_KIB
  ) {
    throw bad(
      `memoryKiB ${String(params.memoryKiB)} (below the ADR-0014 floor or above the anti-DoS cap)`,
    );
  }
  let salt: Uint8Array;
  try {
    salt = base64Decode(params.salt);
  } catch {
    throw bad("salt is not valid base64");
  }
  if (salt.length < 8 || salt.length > 64) throw bad(`salt length ${salt.length}`);
}

/**
 * Which byte string a passphrase becomes before Argon2id sees it (ADR-0057).
 *
 * Unicode lets the same passphrase be typed as different bytes: "café" is one
 * code point on most keyboards (NFC) and two on some IMEs and pasted text
 * (NFD). Argon2id sees bytes, so those are different passphrases and produce
 * different vaults. RFC-0005 now fixes the input as NFC.
 *
 * - `nfc` — the spec. Everything Syncrypt WRITES is derived this way.
 * - `as-typed` — the exact string the user gave, which is what clients before
 *   ADR-0057 used. Read-only, for opening a vault they created.
 * - `nfd` — fully decomposed. Read-only, for opening a vault created on a
 *   device whose input method decomposes.
 */
export type LegacyPassphraseForm = "as-typed" | "nfd";
export type PassphraseForm = "nfc" | LegacyPassphraseForm;

const applyForm = (passphrase: string, form: PassphraseForm): string =>
  form === "nfc" ? passphrase.normalize("NFC")
  : form === "nfd" ? passphrase.normalize("NFD")
  : passphrase;

/**
 * The legacy forms that produce a DIFFERENT byte string than NFC for this
 * passphrase — that is, the other keys this passphrase could already have made.
 *
 * For ASCII — or any text already in NFC and not decomposable — every form is
 * the same string and this returns NOTHING: the overwhelmingly common case
 * derives once, exactly as before, and never asks about legacy forms at all.
 */
export function legacyPassphraseForms(passphrase: string): LegacyPassphraseForm[] {
  const seen = new Set([applyForm(passphrase, "nfc")]);
  const out: LegacyPassphraseForm[] = [];
  for (const form of ["as-typed", "nfd"] as const) {
    const text = applyForm(passphrase, form);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(form);
  }
  return out;
}

/**
 * Argon2id(passphrase, salt, params) → 32-byte Master Key.
 *
 * The passphrase is normalized to NFC unless a legacy `form` is named
 * explicitly — only an unlock that has something to verify against may do that
 * (ADR-0057).
 */
export async function deriveMasterKeyBytes(
  passphrase: string,
  params: KdfParams,
  form: PassphraseForm = "nfc",
): Promise<Uint8Array> {
  validateKdfParams(params);
  const salt = base64Decode(params.salt);
  const mk = await argon2id({
    password: applyForm(passphrase, form),
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
      info: asBufferSource(new TextEncoder().encode(info)),
    },
    hkdfKey,
    SUBKEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

/**
 * One 32-byte subkey from raw key material, bound to `info` (ADR-0028).
 * The caller zeroizes both the input and the result.
 */
export async function deriveSubkeyBytes(material: Uint8Array, info: string): Promise<Uint8Array> {
  const hkdfKey = await crypto.subtle.importKey("raw", asBufferSource(material), "HKDF", false, [
    "deriveBits",
  ]);
  return hkdfSubkey(hkdfKey, info);
}

function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Derive the three role subkeys. Does NOT zeroize the master key (caller's job). */
export async function deriveKeyRing(masterKey: Uint8Array): Promise<KeyRing> {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new SyncError("CryptoAuthError", "invalid master key length");
  }
  const hkdfKey = await crypto.subtle.importKey("raw", asBufferSource(masterKey), "HKDF", false, [
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
