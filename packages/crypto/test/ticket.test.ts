// Connection ticket (ADR-0020): round-trip, fail-closed on wrong passphrase
// and tampering, and no plaintext leakage in the encoded form.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import {
  asBufferSource,
  base64Decode,
  base64Encode,
  createConnectionTicket,
  CROSS_DEVICE_KDF_PRESET,
  deriveMasterKeyBytes,
  deriveSubkeyBytes,
  encodeBlob,
  encodeHeader,
  HKDF_INFO_CONTENT,
  HKDF_INFO_MANIFEST,
  HKDF_INFO_NAMES,
  HKDF_INFO_TICKET,
  openConnectionTicket,
  type ConnectionTicketInput,
} from "../src/index.js";
import type { KdfParams } from "@syncrypt/core";

const INPUT: ConnectionTicketInput = {
  provider: "s3",
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "my-vault-bucket",
  prefix: "vaults/main",
  forcePathStyle: true,
  accessKeyId: "AKIAEXAMPLEKEYID",
  secretAccessKey: "VERY-SECRET-ACCESS-KEY-abc123",
};
const PASSPHRASE = "correct horse battery staple";

describe("connection ticket (ADR-0020)", () => {
  it("round-trips every field, adds nonce + createdAt", async () => {
    const ticket = await createConnectionTicket(INPUT, PASSPHRASE, () => 1_752_800_000);
    const payload = await openConnectionTicket(ticket, PASSPHRASE);
    expect(payload).toMatchObject({ v: 1, ...INPUT });
    expect(payload.createdAt).toBe(1_752_800_000);
    expect(payload.nonce.length).toBeGreaterThan(0);
    // Two tickets for the same input are different (fresh salt + nonce).
    const second = await createConnectionTicket(INPUT, PASSPHRASE);
    expect(second).not.toBe(ticket);
  }, 30_000);

  it("creds-less mode: optional credentials stay absent", async () => {
    const { accessKeyId: _a, secretAccessKey: _s, ...credsLess } = INPUT;
    const ticket = await createConnectionTicket(credsLess, PASSPHRASE);
    const payload = await openConnectionTicket(ticket, PASSPHRASE);
    expect(payload.accessKeyId).toBeUndefined();
    expect(payload.secretAccessKey).toBeUndefined();
    expect(payload.bucket).toBe(INPUT.bucket);
  }, 30_000);

  it("the encoded ticket leaks NO plaintext fields", async () => {
    const ticket = await createConnectionTicket(INPUT, PASSPHRASE);
    for (const secret of [
      INPUT.secretAccessKey ?? "",
      INPUT.accessKeyId ?? "",
      INPUT.bucket,
      INPUT.endpoint,
      "s3.example.com",
    ]) {
      expect(ticket).not.toContain(secret);
      expect(ticket).not.toContain(btoa(secret).replaceAll("=", ""));
    }
  }, 30_000);

  it("wrong passphrase fails closed", async () => {
    const ticket = await createConnectionTicket(INPUT, PASSPHRASE);
    await expect(openConnectionTicket(ticket, "wrong horse")).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
  }, 30_000);

  it("any tampering fails closed (header, body, truncation, garbage)", async () => {
    const ticket = await createConnectionTicket(INPUT, PASSPHRASE);
    const bytes = Uint8Array.from(atob(ticket), (c) => c.charCodeAt(0));
    for (const offset of [0, 10, bytes.length - 2]) {
      const tampered = new Uint8Array(bytes);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
      const b64 = btoa(String.fromCharCode(...tampered));
      await expect(openConnectionTicket(b64, PASSPHRASE)).rejects.toSatisfy((e) =>
        isSyncError(e, "CryptoAuthError"),
      );
    }
    await expect(openConnectionTicket("not!!base64??", PASSPHRASE)).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
    await expect(
      openConnectionTicket(ticket.slice(0, 40), PASSPHRASE),
    ).rejects.toSatisfy((e) => isSyncError(e, "CryptoAuthError"));
  }, 60_000);
});

// --- ADR-0028: the ticket key is bound to its purpose ----------------------

describe("ticket key domain separation (ADR-0028)", () => {
  it("new tickets are written as v2", async () => {
    const ticket = await createConnectionTicket(INPUT, PASSPHRASE);
    expect(base64Decode(ticket)[4]).toBe(2);
  });

  it("the v2 key is NOT the Argon2id output — that is the whole point", async () => {
    const params: KdfParams = {
      ...CROSS_DEVICE_KDF_PRESET,
      salt: base64Encode(new Uint8Array(16).fill(7)),
    };
    const master = await deriveMasterKeyBytes(PASSPHRASE, params);
    const ticketSubkey = await deriveSubkeyBytes(master, HKDF_INFO_TICKET);
    expect(Buffer.from(ticketSubkey).equals(Buffer.from(master))).toBe(false);
    // …and it differs from every vault subkey derived from the same material.
    for (const info of [HKDF_INFO_CONTENT, HKDF_INFO_MANIFEST, HKDF_INFO_NAMES]) {
      const other = await deriveSubkeyBytes(master, info);
      expect(Buffer.from(ticketSubkey).equals(Buffer.from(other)), info).toBe(false);
    }
  });

  it("a v1 ticket made by an older build still imports", async () => {
    // Rebuild the legacy format by hand: Argon2id output used directly as the
    // AES key, version byte 1. If this ever stops working, a user mid-upgrade
    // is stranded with a ticket they cannot import.
    const salt = new Uint8Array(16).fill(3);
    const params: KdfParams = { ...CROSS_DEVICE_KDF_PRESET, salt: base64Encode(salt) };
    const raw = await deriveMasterKeyBytes(PASSPHRASE, params);
    const key = await crypto.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM" }, false, ["encrypt"]);

    const payload = {
      v: 1,
      ...INPUT,
      nonce: base64Encode(new Uint8Array(8).fill(1)),
      createdAt: 1_700_000_000,
    };
    const nonce = new Uint8Array(12).fill(9);
    const header = encodeHeader(nonce);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: asBufferSource(header), tagLength: 128 },
        key,
        asBufferSource(new TextEncoder().encode(JSON.stringify(payload))),
      ),
    );
    const blob = encodeBlob(nonce, ct);
    const HEADER_LENGTH = 33;
    const out = new Uint8Array(HEADER_LENGTH + blob.length);
    const view = new DataView(out.buffer);
    out.set([0x53, 0x59, 0x54, 0x4b], 0);
    out[4] = 1; // the legacy version byte
    out.set(salt, 5);
    view.setUint32(21, params.memoryKiB, false);
    view.setUint32(25, params.iterations, false);
    view.setUint32(29, params.parallelism, false);
    out.set(blob, HEADER_LENGTH);

    const parsed = await openConnectionTicket(base64Encode(out), PASSPHRASE);
    expect(parsed.bucket).toBe(INPUT.bucket);
  });

  it("a v2 ticket cannot be opened with the v1 derivation, and vice versa", async () => {
    const v2 = await createConnectionTicket(INPUT, PASSPHRASE);
    const bytes = base64Decode(v2);
    bytes[4] = 1; // claim it is legacy: the key derivation no longer matches
    await expect(openConnectionTicket(base64Encode(bytes), PASSPHRASE)).rejects.toThrow();
  });
});
