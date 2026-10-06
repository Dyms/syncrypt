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

import { MOBILE_MEMORY_BUDGET_KIB, openSyncEngine } from "@syncrypt/sdk";

import { EN_STRINGS } from "../src/i18n.js";
import { NothingToCheck, passphraseIsDefinitelyWrong } from "../src/passphrase-check.js";
import { unlockFailureMessage } from "../src/unlock-error.js";

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

    // Nothing to check against (ADR-0081): neither "wrong" nor "fine".
    await expect(check(storage, PASSPHRASE)).rejects.toBeInstanceOf(NothingToCheck);

    // Nothing at all: no keyfile, no manifest, no object.
    expect(storage.keys()).toEqual([]);
  });

  it("SO THE VAULT'S PERMANENT KDF PROFILE IS STILL THE ONE THE USER CHOSE", async () => {
    // The real consequence. Share before the first sync, then sync: the
    // keyfile must be the desktop-only profile that was configured, not the
    // cross-device default a verification path happened to pass.
    const storage = new MemoryStorage();
    await check(storage, PASSPHRASE).catch(() => undefined);

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

    // No manifest yet, so verifyAccess returns null: nothing to check against
    // — for the right passphrase AND a typo (ADR-0081) — and nothing written.
    await expect(check(storage, PASSPHRASE)).rejects.toBeInstanceOf(NothingToCheck);
    await expect(check(storage, "a typo")).rejects.toBeInstanceOf(NothingToCheck);
    expect(await storage.get(KEYFILE_KEY)).toEqual(params);
  });
});

describe("a device that cannot afford the vault's KDF (ADR-0063)", () => {
  /** A vault whose salt carries the desktop-only profile (no derivation needed). */
  async function desktopOnlyVault(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.put(KEYFILE_KEY, serializeKdfParams(generateKdfParams(DESKTOP_KDF_PRESET)));
    return storage;
  }

  it("is told so on unlock — not that its correct passphrase is wrong", async () => {
    const storage = await desktopOnlyVault();
    const failure = await openSyncEngine({
      storage,
      vault: new MemoryVault(),
      passphrase: PASSPHRASE,
      deviceId: "phone",
      affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: "KdfUnaffordable" });
    expect(unlockFailureMessage(failure, EN_STRINGS)).toBe(EN_STRINGS.unlockModal.kdfUnaffordable);
  });

  it("cannot check a passphrase, so the check says neither 'wrong' nor 'fine'", async () => {
    // "Wrong" refused the right passphrase; "not wrong" would let Share seal a
    // ticket with a passphrase nothing checked.
    const storage = await desktopOnlyVault();
    for (const typed of [PASSPHRASE, "a typo"]) {
      await expect(
        passphraseIsDefinitelyWrong({
          storage,
          vault: new MemoryVault(),
          storagePrefix: "",
          passphrase: typed,
          deviceId: "phone",
          affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB },
        }),
      ).rejects.toMatchObject({ code: "KdfUnaffordable" });
    }
  });
});
