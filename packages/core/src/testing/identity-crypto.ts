// M1 CryptoPort: encryption is a pass-through identity (M2 brings AES-256-GCM,
// RFC-0005); the content hash is REAL BLAKE3 so change detection and
// content-addressed object keys behave exactly as in production.
//
// @noble/hashes is pure TypeScript with no Node-only APIs (Android-safe).

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  CryptoPort,
  CryptoRole,
  KdfParams,
  MasterKey,
} from "../ports.js";
import type { Hash, ObjectKey } from "../types.js";

export class IdentityCrypto implements CryptoPort {
  deriveMasterKey(_passphrase: string, _params: KdfParams): Promise<MasterKey> {
    return Promise.resolve({} as MasterKey);
  }

  hash(data: Uint8Array): Promise<Hash> {
    return Promise.resolve(`b3:${bytesToHex(blake3(data))}`);
  }

  /** Content-addressed layout "objects/ab/cd/<hex>" (RFC-0004 §Object keys). */
  objectKeyFor(hash: Hash): Promise<ObjectKey> {
    const hex = hash.slice(hash.indexOf(":") + 1);
    return Promise.resolve(`objects/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`);
  }

  encrypt(_role: CryptoRole, data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(data));
  }

  decrypt(_role: CryptoRole, blob: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(blob));
  }
}
