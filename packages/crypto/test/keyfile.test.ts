// keyfile-params.json lifecycle: validation, first-device creation, new-device
// load, and the two-fresh-devices salt race (RFC-0005 §Key storage & unlock).

import { describe, expect, it } from "vitest";

import {
  MANIFESTS_PREFIX,
  OBJECTS_PREFIX,
  SyncError,
  isSyncError,
  type KdfParams,
} from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import {
  CROSS_DEVICE_KDF_PRESET,
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

  it("presets are valid; cross-device is THE default (ADR-0018)", () => {
    expect(() => serializeKdfParams(generateKdfParams(DESKTOP_KDF_PRESET))).not.toThrow();
    expect(() => serializeKdfParams(generateKdfParams(CROSS_DEVICE_KDF_PRESET))).not.toThrow();
    expect(MOBILE_KDF_PRESET).toBe(CROSS_DEVICE_KDF_PRESET);
    const defaulted = generateKdfParams();
    expect(defaulted.memoryKiB).toBe(CROSS_DEVICE_KDF_PRESET.memoryKiB);
    expect(defaulted.iterations).toBe(CROSS_DEVICE_KDF_PRESET.iterations);
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

  it("enforces the ADR-0014 anti-downgrade floor (fail closed)", () => {
    const enc = (v: unknown): Uint8Array =>
      new TextEncoder().encode(JSON.stringify(v));
    // A seeded-weak keyfile (threat-model A3) is refused, not adopted.
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, memoryKiB: 8 })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, memoryKiB: 19455 })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, iterations: 1 })));
    expectAuthError(() => parseKdfParams(enc({ ...TEST_PARAMS, parallelism: 0 })));
    // Exactly at the floor is accepted; shipped presets sit above it.
    expect(() => parseKdfParams(enc(TEST_PARAMS))).not.toThrow();
    expect(TEST_PARAMS.memoryKiB).toBe(19456);
    expect(TEST_PARAMS.iterations).toBe(2);
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

  it("a fresh vault without explicit defaults is created cross-device-safe (ADR-0018)", async () => {
    const storage = new MemoryStorage();
    await openVaultCrypto({ storage, storagePrefix: "", passphrase: "p" });
    const stored = parseKdfParams(await storage.get(KEYFILE_KEY));
    expect(stored.memoryKiB).toBe(CROSS_DEVICE_KDF_PRESET.memoryKiB);
    expect(stored.iterations).toBe(CROSS_DEVICE_KDF_PRESET.iterations);
  });

  it("affordability ceiling refuses unaffordable vault params FAIL-CLOSED (ADR-0018)", async () => {
    // A vault created with the desktop-only profile…
    const storage = new MemoryStorage();
    await storage.put(
      KEYFILE_KEY,
      serializeKdfParams(generateKdfParams(DESKTOP_KDF_PRESET)),
    );
    // …refuses a device with a 64 MiB budget, with an actionable message.
    try {
      await openVaultCrypto({
        storage,
        storagePrefix: "",
        passphrase: "p",
        affordability: { maxMemoryKiB: 65536 },
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isSyncError(e, "CryptoAuthError"), String(e)).toBe(true);
      expect((e as Error).message).toContain("128 MiB");
      expect((e as Error).message).toContain("64 MiB");
    }
    // The same ceiling accepts a cross-device vault (and never mutates params).
    const okStorage = new MemoryStorage();
    await okStorage.put(
      KEYFILE_KEY,
      serializeKdfParams({ ...TEST_PARAMS }),
    );
    const device = await openVaultCrypto({
      storage: okStorage,
      storagePrefix: "",
      passphrase: "p",
      affordability: { maxMemoryKiB: 65536 },
    });
    const blob = await device.encrypt("content", new TextEncoder().encode("ok"));
    expect(blob.length).toBeGreaterThan(0);
    expect(parseKdfParams(await okStorage.get(KEYFILE_KEY))).toEqual(TEST_PARAMS);
  });

  it("the ceiling also guards CREATION: a device never creates a vault it cannot unlock", async () => {
    const storage = new MemoryStorage();
    await expect(
      openVaultCrypto({
        storage,
        storagePrefix: "",
        passphrase: "p",
        defaults: DESKTOP_KDF_PRESET,
        affordability: { maxMemoryKiB: 65536 },
      }),
    ).rejects.toSatisfy((e) => isSyncError(e, "CryptoAuthError"));
    expect(storage.keys()).toEqual([]); // nothing was written
  });

  it("a fresh device that loses the create race adopts the stored salt", async () => {
    const storage = new MemoryStorage({ conditionalWrites: true });
    // Interpose: when this device PUTs its keyfile, a competitor's is already
    // there. create-if-absent refuses ours, and theirs is what the vault uses.
    const competitor = generateKdfParams(TEST_PRESET);
    const originalPut = storage.put.bind(storage);
    let injected = false;
    storage.put = async (key, data, opts) => {
      if (!injected && key === KEYFILE_KEY) {
        injected = true;
        await originalPut(KEYFILE_KEY, serializeKdfParams(competitor));
      }
      return originalPut(key, data, opts);
    };

    const device = await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "p",
      defaults: TEST_PRESET,
    });

    // The salt in storage is the COMPETITOR's — ours never landed — and the
    // device derived from it. Asserting only "device agrees with storage"
    // would pass just as happily if we had overwritten them.
    const stored = parseKdfParams(await storage.get(KEYFILE_KEY));
    expect(stored.salt).toBe(competitor.salt);
    const reference = await openVaultCryptoFromParams(stored);
    const blob = await device.encrypt("content", new TextEncoder().encode("agree"));
    expect(new TextDecoder().decode(await reference.decrypt("content", blob))).toBe("agree");
  });

  it("ONE SPURIOUS 404 DOES NOT COST THE VAULT ITS SALT", async () => {
    // No conditional writes (WebDAV, by design), so nothing but this code
    // stands between a lying 404 and a PUT over the only copy of the salt.
    const storage = new MemoryStorage({ conditionalWrites: false });
    const original = generateKdfParams(TEST_PRESET);
    await storage.put(KEYFILE_KEY, serializeKdfParams(original));

    const realGet = storage.get.bind(storage);
    let lies = 1;
    storage.get = (key) => {
      if (key === KEYFILE_KEY && lies-- > 0) return realGet("no-such-key");
      return realGet(key);
    };

    await openVaultCrypto({ storage, storagePrefix: "", passphrase: "p", defaults: TEST_PRESET });
    expect(parseKdfParams(await realGet(KEYFILE_KEY)).salt).toBe(original.salt);
  });

  it("A VAULT WITH DATA AND NO KEYFILE IS REFUSED, NOT INITIALIZED", async () => {
    for (const [what, key] of [
      ["manifest", `${MANIFESTS_PREFIX}000000004-dev-1.json`],
      ["object", `${OBJECTS_PREFIX}aa/bb/aabb`],
    ] as const) {
      const storage = new MemoryStorage({ conditionalWrites: false });
      const original = generateKdfParams(TEST_PRESET);
      await storage.put(KEYFILE_KEY, serializeKdfParams(original));
      await storage.put(key, new TextEncoder().encode("ciphertext"));

      // The server keeps insisting the keyfile is not there.
      const realGet = storage.get.bind(storage);
      storage.get = (k) => (k === KEYFILE_KEY ? realGet("no-such-key") : realGet(k));

      await expect(
        openVaultCrypto({ storage, storagePrefix: "", passphrase: "p", defaults: TEST_PRESET }),
        what,
      ).rejects.toSatisfy((e) => isSyncError(e, "VaultKeyfileMissing"));
      expect(parseKdfParams(await realGet(KEYFILE_KEY)).salt, what).toBe(original.salt);
    }
  });

  it("the refusal respects the vault prefix — a neighbour's data is not ours", async () => {
    const storage = new MemoryStorage({ conditionalWrites: false });
    await storage.put(`other/${MANIFESTS_PREFIX}000000004-dev-1.json`, new TextEncoder().encode("x"));
    // Empty vault under OUR prefix: creating the salt is exactly right here.
    const crypto = await openVaultCrypto({
      storage,
      storagePrefix: "mine",
      passphrase: "p",
      defaults: TEST_PRESET,
    });
    expect(crypto).toBeDefined();
    expect(storage.keys()).toContain(`mine/${KEYFILE_KEY}`);
  });

  it("a storage that cannot be listed is not a vault to initialize", async () => {
    const storage = new MemoryStorage({ conditionalWrites: false });
    storage.list = () => {
      throw new SyncError("StorageTransient", "listing is down");
    };
    await expect(
      openVaultCrypto({ storage, storagePrefix: "", passphrase: "p", defaults: TEST_PRESET }),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageTransient"));
    expect(storage.keys()).toEqual([]); // nothing written
  });

  async function openVaultCryptoFromParams(params: KdfParams) {
    const { SyncryptCrypto } = await import("../src/index.js");
    return SyncryptCrypto.create("p", params);
  }
});
