import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import {
  encodeBlob,
  encodeHeader,
  HEADER_LENGTH,
  NONCE_LENGTH,
  parseBlob,
  TAG_LENGTH,
} from "../src/index.js";

const nonce = Uint8Array.from({ length: NONCE_LENGTH }, (_, i) => i + 1);

function expectAuthError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(isSyncError(e, "CryptoAuthError"), String(e)).toBe(true);
  }
}

describe("blob v1 format (RFC-0005)", () => {
  it("encodes header|ciphertext|tag and parses it back", () => {
    const payload = new Uint8Array(TAG_LENGTH + 5).fill(0xab);
    const blob = encodeBlob(nonce, payload);
    expect(blob.length).toBe(HEADER_LENGTH + payload.length);
    expect(new TextDecoder().decode(blob.subarray(0, 4))).toBe("SYNC");
    expect(blob[4]).toBe(1); // version
    expect(blob[5]).toBe(1); // alg = AES-256-GCM

    const parts = parseBlob(blob);
    expect(parts.nonce).toEqual(nonce);
    expect(parts.header).toEqual(blob.subarray(0, HEADER_LENGTH));
    expect(parts.ciphertextAndTag).toEqual(payload);
  });

  it("the AAD header equals the first 18 bytes of the blob", () => {
    const header = encodeHeader(nonce);
    const blob = encodeBlob(nonce, new Uint8Array(TAG_LENGTH));
    expect(header).toEqual(blob.subarray(0, HEADER_LENGTH));
  });

  it("fails closed on truncation, bad magic, bad version, bad alg", () => {
    const good = encodeBlob(nonce, new Uint8Array(TAG_LENGTH).fill(7));
    expectAuthError(() => parseBlob(good.subarray(0, HEADER_LENGTH + TAG_LENGTH - 1)));
    expectAuthError(() => parseBlob(new Uint8Array(0)));

    const badMagic = new Uint8Array(good);
    badMagic[0] = 0x58;
    expectAuthError(() => parseBlob(badMagic));

    const badVersion = new Uint8Array(good);
    badVersion[4] = 2;
    expectAuthError(() => parseBlob(badVersion));

    const badAlg = new Uint8Array(good);
    badAlg[5] = 9;
    expectAuthError(() => parseBlob(badAlg));
  });
});
