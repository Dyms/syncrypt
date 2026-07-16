// SyncryptCrypto — the reference CryptoPort (RFC-0007 §2.3, RFC-0005, ADR-0003).
//
// - encrypt/decrypt: AES-256-GCM via WebCrypto, blob v1, header as AAD,
//   fresh random 96-bit nonce per encryption. Tamper / wrong key ⇒
//   SyncError("CryptoAuthError") and the data is NEVER applied (fail-closed).
// - hash: BLAKE3 over PLAINTEXT, "b3:<hex64>" (same format the engine used
//   with the M1 identity impl — change detection is unaffected).
// - objectKeyFor: BLAKE3 keyed mode (key = Name Key) over the raw 32 bytes of
//   the content hash → "objects/ab/cd/<hex64>". Reveals neither path nor
//   plaintext; deterministic per vault key.

import { blake3 } from "hash-wasm";

import {
  SyncError,
  type CryptoPort,
  type CryptoRole,
  type Hash,
  type KdfParams,
  type MasterKey,
  type ObjectKey,
} from "@syncrypt/core";

import { encodeBlob, encodeHeader, NONCE_LENGTH, parseBlob, TAG_LENGTH } from "./format.js";
import { deriveKeyRing, deriveMasterKeyBytes, zeroize, type KeyRing } from "./keys.js";

const HASH_PREFIX = "b3:";
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

/** Internal shape behind the opaque MasterKey brand. Never serialized. */
interface MasterKeyBox {
  readonly __brand: "MasterKey";
  readonly bytes: Uint8Array;
}

export class SyncryptCrypto implements CryptoPort {
  private constructor(private readonly ring: KeyRing) {}

  /** Derive the full key ring from a passphrase + stored KDF params. */
  static async create(passphrase: string, params: KdfParams): Promise<SyncryptCrypto> {
    const mk = await deriveMasterKeyBytes(passphrase, params);
    try {
      return new SyncryptCrypto(await deriveKeyRing(mk));
    } finally {
      zeroize(mk); // MK is not retained; subkeys suffice for all operations
    }
  }

  async deriveMasterKey(passphrase: string, params: KdfParams): Promise<MasterKey> {
    const bytes = await deriveMasterKeyBytes(passphrase, params);
    const box: MasterKeyBox = { __brand: "MasterKey", bytes };
    return box;
  }

  async hash(data: Uint8Array): Promise<Hash> {
    return `${HASH_PREFIX}${await blake3(data)}`;
  }

  async objectKeyFor(hash: Hash): Promise<ObjectKey> {
    if (!hash.startsWith(HASH_PREFIX) || !HASH_HEX_RE.test(hash.slice(HASH_PREFIX.length))) {
      throw new SyncError(
        "ManifestCorrupt",
        `cannot derive an object key from malformed hash "${hash}"`,
      );
    }
    const raw = hexDecode(hash.slice(HASH_PREFIX.length));
    const keyed = await blake3(raw, 256, this.ring.nameKey);
    return `objects/${keyed.slice(0, 2)}/${keyed.slice(2, 4)}/${keyed}`;
  }

  private keyFor(role: CryptoRole): CryptoKey {
    return role === "manifest" ? this.ring.manifestKey : this.ring.contentKey;
  }

  async encrypt(role: CryptoRole, data: Uint8Array): Promise<Uint8Array> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const header = encodeHeader(nonce);
    const ciphertextAndTag = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: header, tagLength: TAG_LENGTH * 8 },
      this.keyFor(role),
      data,
    );
    return encodeBlob(nonce, new Uint8Array(ciphertextAndTag));
  }

  async decrypt(role: CryptoRole, blob: Uint8Array): Promise<Uint8Array> {
    const parts = parseBlob(blob);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: parts.nonce,
          additionalData: parts.header,
          tagLength: TAG_LENGTH * 8,
        },
        this.keyFor(role),
        parts.ciphertextAndTag,
      );
      return new Uint8Array(plaintext);
    } catch (e) {
      // GCM tag mismatch: wrong passphrase or tampered data. FAIL CLOSED.
      throw new SyncError(
        "CryptoAuthError",
        "decryption failed (wrong passphrase or tampered data) — not applied",
        e,
      );
    }
  }
}

function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
