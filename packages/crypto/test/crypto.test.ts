// SyncryptCrypto — round-trips, fail-closed behavior, hash/objectKey properties.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";
import { IdentityCrypto } from "@syncrypt/core/testing";

import { HEADER_LENGTH, SyncryptCrypto } from "../src/index.js";
import { TEST_PARAMS } from "./params.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

async function expectAuthError(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(isSyncError(e, "CryptoAuthError"), String(e)).toBe(true);
  }
}

describe("encrypt/decrypt (AES-256-GCM, blob v1)", () => {
  it("round-trips content and manifest roles, including empty and binary data", async () => {
    const c = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    for (const role of ["content", "manifest"] as const) {
      for (const data of [
        new Uint8Array(0),
        enc("hello world"),
        crypto.getRandomValues(new Uint8Array(4096)),
      ]) {
        const blob = await c.encrypt(role, data);
        expect(dec(blob.subarray(0, 4))).toBe("SYNC");
        expect(await c.decrypt(role, blob)).toEqual(data);
      }
    }
  });

  it("ciphertext reveals nothing: no plaintext bytes, fresh nonce every time", async () => {
    const c = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const plaintext = enc("very secret note contents");
    const blobs = await Promise.all(
      Array.from({ length: 50 }, () => c.encrypt("content", plaintext)),
    );
    const seen = new Set<string>();
    for (const blob of blobs) {
      expect(dec(blob)).not.toContain("very secret");
      const nonceHex = [...blob.subarray(6, HEADER_LENGTH)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(seen.has(nonceHex), "nonce reused").toBe(false);
      seen.add(nonceHex);
    }
  });

  it("wrong passphrase fails closed", async () => {
    const alice = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const mallory = await SyncryptCrypto.create("wrong horse", TEST_PARAMS);
    const blob = await alice.encrypt("content", enc("secret"));
    await expectAuthError(mallory.decrypt("content", blob));
  });

  it("role separation: a content blob does not decrypt as manifest", async () => {
    const c = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const blob = await c.encrypt("content", enc("secret"));
    await expectAuthError(c.decrypt("manifest", blob));
  });

  it("any single-byte tamper anywhere fails closed", async () => {
    const c = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const blob = await c.encrypt("content", enc("payload under test"));
    // magic, version, alg, nonce, ciphertext middle, tag
    const offsets = [0, 4, 5, 10, HEADER_LENGTH + 3, blob.length - 1];
    for (const offset of offsets) {
      const tampered = new Uint8Array(blob);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
      await expectAuthError(c.decrypt("content", tampered));
    }
  });

  it("derivation is deterministic: two instances from the same passphrase interoperate", async () => {
    const a = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const b = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const blob = await a.encrypt("manifest", enc("shared state"));
    expect(dec(await b.decrypt("manifest", blob))).toBe("shared state");
  });
});

describe("hash (BLAKE3 over plaintext)", () => {
  it("matches the known BLAKE3 vector and the M1 identity implementation", async () => {
    const c = await SyncryptCrypto.create("x", TEST_PARAMS);
    // BLAKE3 of empty input (cross-checked: hash-wasm and @noble agree).
    expect(await c.hash(new Uint8Array(0))).toBe(
      "b3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
    const identity = new IdentityCrypto();
    for (const data of [enc("hello"), crypto.getRandomValues(new Uint8Array(1000))]) {
      expect(await c.hash(data)).toBe(await identity.hash(data));
    }
  });
});

describe("objectKeyFor (keyed BLAKE3 under the Name Key)", () => {
  const contentHash =
    "b3:af1349b9f5f9a1a6a0404dee36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

  it("is deterministic per vault key and shaped objects/ab/cd/<hex64>", async () => {
    const a = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const b = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const key = await a.objectKeyFor(contentHash);
    expect(key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(await b.objectKeyFor(contentHash)).toBe(key);
    expect(key.slice(8, 10) + key.slice(11, 13)).toBe(key.slice(14, 18)); // sharding = prefix of hex
  });

  it("reveals neither the content hash nor anything about the plaintext", async () => {
    const c = await SyncryptCrypto.create("correct horse", TEST_PARAMS);
    const key = await c.objectKeyFor(contentHash);
    expect(key).not.toContain(contentHash.slice(3, 19)); // no hash prefix leak
    // A different vault key produces an unrelated object key for the SAME content.
    const other = await SyncryptCrypto.create("different passphrase", TEST_PARAMS);
    expect(await other.objectKeyFor(contentHash)).not.toBe(key);
  });

  it("rejects malformed hashes (fail closed)", async () => {
    const c = await SyncryptCrypto.create("x", TEST_PARAMS);
    for (const bad of ["", "b3:", "b3:zz", "sha256:abcd", `b3:${"a".repeat(63)}`]) {
      try {
        await c.objectKeyFor(bad);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(isSyncError(e, "ManifestCorrupt"), String(e)).toBe(true);
      }
    }
  });
});
