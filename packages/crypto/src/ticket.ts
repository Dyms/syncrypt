// Connection ticket (ADR-0020): every connection field EXCEPT the passphrase,
// encrypted UNDER the passphrase for second-device enrollment.
//
//   "SYTK" | ver(1) | salt(16) | memoryKiB(u32) | iterations(u32) |
//   parallelism(u32) | <standard v1 AES-256-GCM blob, header as AAD>
//
// — base64-encoded for copy/paste transport. The salt is fresh and
// independent of the vault keyfile; the KDF profile is CROSS-DEVICE (the
// importing device may be a phone). Wrong passphrase or tampering fails
// closed with CryptoAuthError and nothing is applied. True one-time-ness is
// impossible without server state: the embedded nonce + createdAt exist so
// UIs can tell the user which ticket they are looking at and remind them to
// delete it after use.

import { SyncError, type KdfParams } from "@syncrypt/core";

import { encodeBlob, encodeHeader, NONCE_LENGTH, parseBlob, TAG_LENGTH } from "./format.js";
import { CROSS_DEVICE_KDF_PRESET } from "./keyfile.js";
import {
  asBufferSource,
  base64Decode,
  base64Encode,
  deriveMasterKeyBytes,
  validateKdfParams,
  zeroize,
} from "./keys.js";

export interface ConnectionTicketPayload {
  v: 1;
  provider: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  /** Optional: the cautious can export a creds-less ticket (config only). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Random ticket id — lets UIs refer to "this ticket" and hint deletion. */
  nonce: string;
  createdAt: number; // epoch seconds
}

export type ConnectionTicketInput = Omit<ConnectionTicketPayload, "v" | "nonce" | "createdAt">;

const MAGIC = new Uint8Array([0x53, 0x59, 0x54, 0x4b]); // "SYTK"
const TICKET_VERSION = 1;
const SALT_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + 3 * 4; // 33

function corrupt(detail: string): SyncError {
  return new SyncError("CryptoAuthError", `not a valid connection ticket: ${detail}`);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, false);
}

async function ticketKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  const raw = await deriveMasterKeyBytes(passphrase, params);
  try {
    return await crypto.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    zeroize(raw);
  }
}

/** Produce a base64 ticket from connection fields + the vault passphrase. */
export async function createConnectionTicket(
  input: ConnectionTicketInput,
  passphrase: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: ConnectionTicketPayload = {
    v: 1,
    ...input,
    nonce: base64Encode(crypto.getRandomValues(new Uint8Array(8))),
    createdAt: now(),
  };

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const params: KdfParams = { ...CROSS_DEVICE_KDF_PRESET, salt: base64Encode(salt) };
  const key = await ticketKey(passphrase, params);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const header = encodeHeader(nonce);
  const ciphertextAndTag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: asBufferSource(header), tagLength: TAG_LENGTH * 8 },
    key,
    asBufferSource(new TextEncoder().encode(JSON.stringify(payload))),
  );
  const blob = encodeBlob(nonce, new Uint8Array(ciphertextAndTag));

  const out = new Uint8Array(HEADER_LENGTH + blob.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = TICKET_VERSION;
  out.set(salt, 5);
  writeU32(view, 21, params.memoryKiB);
  writeU32(view, 25, params.iterations);
  writeU32(view, 29, params.parallelism);
  out.set(blob, HEADER_LENGTH);
  return base64Encode(out);
}

/** Decrypt + strictly validate a ticket. FAIL-CLOSED: wrong passphrase or any
 *  tamper throws CryptoAuthError; callers must not apply anything partially. */
export async function openConnectionTicket(
  ticket: string,
  passphrase: string,
): Promise<ConnectionTicketPayload> {
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(ticket.trim());
  } catch {
    throw corrupt("not base64");
  }
  if (bytes.length < HEADER_LENGTH + 18 + TAG_LENGTH) throw corrupt("truncated");
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw corrupt("bad magic");
  }
  if (bytes[4] !== TICKET_VERSION) throw corrupt(`unsupported version ${String(bytes[4])}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const params: KdfParams = {
    kdf: "argon2id",
    version: 1,
    salt: base64Encode(bytes.subarray(5, 5 + SALT_LENGTH)),
    memoryKiB: view.getUint32(21, false),
    iterations: view.getUint32(25, false),
    parallelism: view.getUint32(29, false),
  };
  validateKdfParams(params); // ADR-0014 floor + anti-DoS ceiling apply here too

  const key = await ticketKey(passphrase, params);
  const parts = parseBlob(bytes.subarray(HEADER_LENGTH));
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(parts.nonce),
          additionalData: asBufferSource(parts.header),
          tagLength: TAG_LENGTH * 8,
        },
        key,
        asBufferSource(parts.ciphertextAndTag),
      ),
    );
  } catch (e) {
    throw new SyncError(
      "CryptoAuthError",
      "ticket decryption failed (wrong passphrase or tampered ticket) — nothing applied",
      e,
    );
  }
  return validatePayload(plaintext);
}

function validatePayload(plaintext: Uint8Array): ConnectionTicketPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw corrupt("payload is not JSON");
  }
  if (typeof raw !== "object" || raw === null) throw corrupt("payload is not an object");
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) throw corrupt("unsupported payload version");
  if (r.provider !== "s3") throw corrupt(`unsupported provider "${String(r.provider)}"`);
  for (const field of ["endpoint", "region", "bucket", "prefix", "nonce"]) {
    if (typeof r[field] !== "string") throw corrupt(`missing field ${field}`);
  }
  if (typeof r.forcePathStyle !== "boolean") throw corrupt("missing field forcePathStyle");
  if (typeof r.createdAt !== "number") throw corrupt("missing field createdAt");
  for (const field of ["accessKeyId", "secretAccessKey"]) {
    if (r[field] !== undefined && typeof r[field] !== "string") {
      throw corrupt(`invalid field ${field}`);
    }
  }
  return r as unknown as ConnectionTicketPayload;
}
