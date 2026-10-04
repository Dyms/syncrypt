// ADR-0060. "Share connection" checks the passphrase first (ADR-0048). The
// check must answer only when it is sure, and must not write — the path it
// used creates `meta/keyfile-params.json` when the vault has none, and did so
// without the chosen KDF preset, deciding the vault's permanent profile from a
// button that looks like a read.

import { describe, expect, it } from "vitest";

import {
  CROSS_DEVICE_KDF_PRESET,
  DESKTOP_KDF_PRESET,
  generateKdfParams,
  KEYFILE_KEY,
  openVaultCrypto,
  parseKdfParams,
  serializeKdfParams,
} from "@syncrypt/crypto";
import { SyncError } from "@syncrypt/core";
import {
  FixedClock,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "@syncrypt/core/testing";

import { passphraseIsDefinitelyWrong } from "../src/passphrase-check.js";

const PASSPHRASE = "the vault passphrase";
const TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

const check = (storage: MemoryStorage, passphrase: string, prefix = ""): Promise<boolean> =>
  passphraseIsDefinitelyWrong({
    storage,
    vault: new MemoryVault(),
    storagePrefix: prefix,
    passphrase,
    deviceId: "dev-a",
  });

/** A vault that exists: keyfile written, one generation published. */
async function realVault(prefix = ""): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  const crypto = await openVaultCrypto({
    storage,
    storagePrefix: prefix,
    passphrase: PASSPHRASE,
    defaults: TEST_PRESET,
  });
  const { createSyncEngine } = await import("@syncrypt/core");
  const vault = new MemoryVault();
  vault.setFile("note.md", "published");
  await createSyncEngine({
    storage,
    vault,
    crypto,
    clock: new FixedClock(),
    state: new MemoryStateStore(),
    deviceId: "dev-a",
    storagePrefix: prefix,
  }).sync();
  return storage;
}

describe("the check answers only when it is sure", () => {
  it("the right passphrase is not wrong", async () => {
    expect(await check(await realVault(), PASSPHRASE)).toBe(false);
  });

  it("A TYPO IS WRONG — WHICH IS THE WHOLE POINT OF THE CHECK", async () => {
    expect(await check(await realVault(), "the vault passphras")).toBe(true);
  });

  it("an unreachable bucket says nothing about the passphrase", async () => {
    const storage = new MemoryStorage();
    const failing = Object.create(storage) as MemoryStorage;
    failing.get = () =>
      Promise.reject(new SyncError("StorageTransient", "the bucket is unreachable"));
    expect(await check(failing, PASSPHRASE)).toBe(false);
  });

  it("works under the vault's prefix", async () => {
    const storage = await realVault("vaults/main");
    expect(await check(storage, PASSPHRASE, "vaults/main")).toBe(false);
    expect(await check(storage, "wrong", "vaults/main")).toBe(true);
  });
});

describe("the check does not write", () => {
  it("A VAULT WITH NO KEYFILE IS NOT GIVEN ONE", async () => {
    const storage = new MemoryStorage();

    expect(await check(storage, PASSPHRASE)).toBe(false);

    // Nothing at all: no keyfile, no manifest, no object.
    expect(storage.keys()).toEqual([]);
  });

  it("SO THE VAULT'S PERMANENT KDF PROFILE IS STILL THE ONE THE USER CHOSE", async () => {
    // The real consequence. Share before the first sync, then sync: the
    // keyfile must be the desktop-only profile that was configured, not the
    // cross-device default a verification path happened to pass.
    const storage = new MemoryStorage();
    await check(storage, PASSPHRASE);

    await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: PASSPHRASE,
      defaults: DESKTOP_KDF_PRESET,
    });
    const stored = parseKdfParams(await storage.get(KEYFILE_KEY));
    expect(stored.memoryKiB).toBe(DESKTOP_KDF_PRESET.memoryKiB);
    expect(stored.memoryKiB).not.toBe(CROSS_DEVICE_KDF_PRESET.memoryKiB);
  });

  it("an existing vault is not touched by being checked", async () => {
    const storage = await realVault();
    const before = storage.keys();
    const params = await storage.get(KEYFILE_KEY);

    await check(storage, PASSPHRASE);
    await check(storage, "wrong");

    expect(storage.keys()).toEqual(before);
    expect(await storage.get(KEYFILE_KEY)).toEqual(params);
  });

  it("and a keyfile written by another device is used, not replaced", async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYFILE_KEY, serializeKdfParams(generateKdfParams(TEST_PRESET)));
    const params = await storage.get(KEYFILE_KEY);

    // No manifest yet, so verifyAccess returns null: not wrong, nothing written.
    expect(await check(storage, PASSPHRASE)).toBe(false);
    expect(await storage.get(KEYFILE_KEY)).toEqual(params);
  });
});
