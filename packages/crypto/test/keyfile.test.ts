// keyfile-params.json lifecycle: validation, first-device creation, new-device
// load, and the two-fresh-devices salt race (RFC-0005 §Key storage & unlock).

import { describe, expect, it } from "vitest";

import { isSyncError, type KdfParams } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import {
  DESKTOP_KDF_PRESET,
  generateKdfParams,
  KEYFILE_KEY,
  MOBILE_KDF_PRESET,
  openVaultCrypto,
  parseKdfParams,
  serializeKdfParams,
} from "../src/index.js";
import { TEST_PARAMS, TEST_PRESET } from "./params.js";

function expectAuthError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(isSyncError(e, "CryptoAuthError"), String(e)).toBe(true);
  }
}

describe("KdfParams (de)serialization", () => {
  it("round-trips and generates a fresh 128-bit salt each time", () => {
    const p1 = generateKdfParams(TEST_PRESET);
    const p2 = generateKdfParams(TEST_PRESET);
    expect(p1.salt).not.toBe(p2.salt);
    expect(atob(p1.salt)).toHaveLength(16);
    expect(parseKdfParams(serializeKdfParams(p1))).toEqual(p1);
  });

  it("presets are valid", () => {
    expect(() => serializeKdfParams(generateKdfParams(DESKTOP_KDF_PRESET))).not.toThrow();
    expect(() => serializeKdfParams(generateKdfParams(MOBILE_KDF_PRESET))).not.toThrow();
  });

  it("fails closed on garbage, wrong kdf, and poisoned (oversized) params", () => {
    const enc = (v: unknown): Uint8Array =>
      new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
    expectAuthError(() => parseKdfParams(enc("{nope")));
    expectAuthError(() => parseKdfParams(enc([1, 2])));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, kdf: "pbkdf2" })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, version: 2 })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, salt: "!!not-base64!!" })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, salt: "AAAA" }))); // 3 bytes
    // Poisoned keyfile must not OOM the device: 8 GiB memory is refused.
    expectAuthError(() =>
      parseKdfParams(enc({ ...TEST_PARAMS, memoryKiB: 8 * 1024 * 1024 })),
    );
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, iterations: 10_000 })));
  });
});

describe("openVaultCrypto", () => {
  it("first device creates the keyfile; a new device joins with only the passphrase", async () => {
    const storage = new MemoryStorage();
    const a = await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "correct horse",
      defaults: TEST_PRESET,
    });
    expect(storage.keys()).toContain(KEYFILE_KEY);

    const blob = await a.encrypt("content", new TextEncoder().encode("cross-device"));
    const b = await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "correct horse",
    });
    expect(new TextDecoder().decode(await b.decrypt("content", blob))).toBe(
      "cross-device",
    );
  });

  it("respects the storage prefix", async () => {
    const storage = new MemoryStorage();
    await openVaultCrypto({
      storage,
      storagePrefix: "vaults/main/",
      passphrase: "p",
      defaults: TEST_PRESET,
    });
    expect(storage.keys()).toEqual([`vaults/main/${KEYFILE_KEY}`]);
  });

  it("keyfile params are stored in the clear and contain no secrets", async () => {
    const storage = new MemoryStorage();
    await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "super secret passphrase",
      defaults: TEST_PRESET,
    });
    const text = new TextDecoder().decode(await storage.get(KEYFILE_KEY));
    expect(text).not.toContain("super secret");
    const params = parseKdfParams(new TextEncoder().encode(text));
    expect(params.kdf).toBe("argon2id");
  });

  it("two fresh devices racing to create the salt converge on the stored one", async () => {
    for (const conditionalWrites of [true, false]) {
      const storage = new MemoryStorage({ conditionalWrites });
      // Interpose: when the first device PUTs its keyfile, a competitor's
      // keyfile lands first.
      const competitor = serializeKdfParams(generateKdfParams(TEST_PRESET));
      const originalPut = storage.put.bind(storage);
      let injected = false;
      storage.put = async (key, data, opts) => {
        if (!injected && key === KEYFILE_KEY) {
          injected = true;
          await originalPut(KEYFILE_KEY, competitor);
        }
        return originalPut(key, data, opts);
      };

      const device = await openVaultCrypto({
        storage,
        storagePrefix: "",
        passphrase: "p",
        defaults: TEST_PRESET,
      });
      // The device must have derived from whatever is ACTUALLY stored.
      const stored = parseKdfParams(await storage.get(KEYFILE_KEY));
      const reference = await openVaultCryptoFromParams(stored);
      const blob = await device.encrypt("content", new TextEncoder().encode("agree"));
      expect(
        new TextDecoder().decode(await reference.decrypt("content", blob)),
        `capability mode conditionalWrites=${String(conditionalWrites)}`,
      ).toBe("agree");
    }

    async function openVaultCryptoFromParams(params: KdfParams) {
      const { SyncryptCrypto } = await import("../src/index.js");
      return SyncryptCrypto.create("p", params);
    }
  });
});
