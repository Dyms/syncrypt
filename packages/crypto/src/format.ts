// Blob format v1 — RFC-0005 §File object format.
//
//   magic "SYNC" (4) | version=1 (1) | alg=1 AES-256-GCM (1) | nonce (12)
//   | ciphertext (N) | GCM tag (16)
//
// The 18-byte header (magic|version|alg|nonce) is bound as AAD, so version
// downgrade or header tampering fails authentication. Parsing FAILS CLOSED:
// anything malformed throws SyncError("CryptoAuthError").

import { SyncError } from "@syncrypt/core";

export const MAGIC = new Uint8Array([0x53, 0x59, 0x4e, 0x43]); // "SYNC"
export const FORMAT_VERSION = 1;
export const ALG_AES_256_GCM = 1;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const HEADER_LENGTH = MAGIC.length + 1 + 1 + NONCE_LENGTH; // 18

export interface BlobParts {
  /** The full 18-byte header — the GCM AAD. */
  header: Uint8Array;
  nonce: Uint8Array;
  /** ciphertext || tag, exactly as WebCrypto produces/consumes it. */
  ciphertextAndTag: Uint8Array;
}

/** Assemble a v1 blob from a fresh nonce and WebCrypto output (ct||tag). */
export function encodeBlob(nonce: Uint8Array, ciphertextAndTag: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_LENGTH) {
    throw new SyncError("CryptoAuthError", `internal: nonce must be ${NONCE_LENGTH} bytes`);
  }
  const blob = new Uint8Array(HEADER_LENGTH + ciphertextAndTag.length);
  blob.set(MAGIC, 0);
  blob[4] = FORMAT_VERSION;
  blob[5] = ALG_AES_256_GCM;
  blob.set(nonce, 6);
  blob.set(ciphertextAndTag, HEADER_LENGTH);
  return blob;
}

/** Build the header for a nonce without the payload (AAD for encryption). */
export function encodeHeader(nonce: Uint8Array): Uint8Array {
  return encodeBlob(nonce, new Uint8Array(0));
}

function reject(detail: string): SyncError {
  return new SyncError("CryptoAuthError", `not a valid Syncrypt blob: ${detail} — not applied`);
}

/** Strictly parse a v1 blob. Fail-closed on anything unexpected. */
export function parseBlob(blob: Uint8Array): BlobParts {
  if (blob.length < HEADER_LENGTH + TAG_LENGTH) throw reject("truncated");
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw reject("bad magic");
  }
  if (blob[4] !== FORMAT_VERSION) throw reject(`unsupported version ${String(blob[4])}`);
  if (blob[5] !== ALG_AES_256_GCM) throw reject(`unsupported algorithm ${String(blob[5])}`);
  return {
    header: blob.subarray(0, HEADER_LENGTH),
    nonce: blob.subarray(6, HEADER_LENGTH),
    ciphertextAndTag: blob.subarray(HEADER_LENGTH),
  };
}
