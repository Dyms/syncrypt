// ADR-0060. Three findings about things the code SAID rather than did.
//
// ADR-0018 §2 promises "mobile devices will refuse to join such a vault", and
// §3 gave the mobile budget the same number as the desktop-only profile it was
// supposed to refuse. With a strict `>` comparison, 128 MiB does not exceed
// 128 MiB, so an Android webview was handed the heavy derivation instead of a
// clear refusal. The invariant between those two constants is what this file
// pins — two numbers in one document cannot be trusted to stay consistent
// without something that fails when they drift.
//
// And `openVaultCrypto` is "load or CREATE". A client that only wants to check
// a passphrase has no business on that path: a vault with no keyfile has no
// passphrase to be wrong about, and taking the path writes the vault's one
// permanent KDF profile.

import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import {
  CROSS_DEVICE_KDF_PRESET,
  DESKTOP_KDF_PRESET,
  generateKdfParams,
  KEYFILE_KEY,
  keyfilePathFor,
  MOBILE_MEMORY_BUDGET_KIB,
  openVaultCrypto,
  parseKdfParams,
  serializeKdfParams,
  vaultHasKeyfile,
} from "../src/index.js";
import { TEST_PRESET } from "./params.js";

describe("the mobile budget and the desktop profile", () => {
  it("THE BUDGET IS STRICTLY BELOW THE PROFILE IT MUST REFUSE", () => {
    // If these are ever equal again, ADR-0018 §2 stops being true and this
    // test is the thing that says so.
    expect(MOBILE_MEMORY_BUDGET_KIB).toBeLessThan(DESKTOP_KDF_PRESET.memoryKiB);
  });

  it("and at or above the profile every device must be able to join", () => {
    expect(MOBILE_MEMORY_BUDGET_KIB).toBeGreaterThanOrEqual(
      CROSS_DEVICE_KDF_PRESET.memoryKiB,
    );
  });

  it("A DESKTOP-ONLY VAULT IS REFUSED ON THE MOBILE BUDGET", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYFILE_KEY,
      serializeKdfParams(generateKdfParams(DESKTOP_KDF_PRESET)),
    );

    await expect(
      openVaultCrypto({
        storage,
        storagePrefix: "",
        passphrase: "p",
        affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB },
      }),
    ).rejects.toThrow(/128 MiB/);
  });

  it("a cross-device vault is not", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYFILE_KEY,
      serializeKdfParams(generateKdfParams(CROSS_DEVICE_KDF_PRESET)),
    );
    const crypto = await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "p",
      affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB },
    });
    expect(crypto).toBeDefined();
  });
});

describe("looking without creating", () => {
  it("A VAULT WITH NO KEYFILE IS REPORTED AS SUCH, AND NOT GIVEN ONE", async () => {
    const storage = new MemoryStorage();
    expect(await vaultHasKeyfile(storage, "")).toBe(false);
    expect(storage.keys()).toEqual([]); // the question wrote nothing
  });

  it("finds it under the vault's own prefix, and not under another's", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      "vaults/main/" + KEYFILE_KEY,
      serializeKdfParams(generateKdfParams(TEST_PRESET)),
    );
    expect(await vaultHasKeyfile(storage, "vaults/main")).toBe(true);
    expect(await vaultHasKeyfile(storage, "vaults/main/")).toBe(true);
    expect(await vaultHasKeyfile(storage, "vaults/other")).toBe(false);
    expect(await vaultHasKeyfile(storage, "")).toBe(false);
  });

  it("the path it looks at is the path openVaultCrypto writes", async () => {
    const storage = new MemoryStorage();
    await openVaultCrypto({
      storage,
      storagePrefix: "vaults/main/",
      passphrase: "p",
      defaults: TEST_PRESET,
    });
    expect(storage.keys()).toEqual([keyfilePathFor("vaults/main")]);
    expect(await vaultHasKeyfile(storage, "vaults/main/")).toBe(true);
  });

  it("A STORAGE THAT CANNOT ANSWER IS NOT AN ABSENT KEYFILE", async () => {
    // "I could not look" must not read as "there is none" — that is how a
    // caller ends up creating a second salt over a vault that has one.
    const storage = new MemoryStorage();
    const failing = Object.create(storage) as MemoryStorage;
    failing.get = () => Promise.reject(new Error("socket closed"));
    await expect(vaultHasKeyfile(failing, "")).rejects.toThrow(/socket closed/);
  });

  it("and the profile a fresh vault gets is the one that was asked for", async () => {
    // B13's other half: the keyfile is written ONCE and is permanent, so a
    // path that creates it without passing the chosen preset decides the
    // vault's KDF for ever.
    const storage = new MemoryStorage();
    await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: "p",
      defaults: DESKTOP_KDF_PRESET,
    });
    expect(parseKdfParams(await storage.get(KEYFILE_KEY)).memoryKiB).toBe(
      DESKTOP_KDF_PRESET.memoryKiB,
    );
  });
});
