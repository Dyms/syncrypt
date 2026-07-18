// Connection ticket (ADR-0020): round-trip, fail-closed on wrong passphrase
// and tampering, and no plaintext leakage in the encoded form.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import {
  createConnectionTicket,
  openConnectionTicket,
  type ConnectionTicketInput,
} from "../src/index.js";

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
