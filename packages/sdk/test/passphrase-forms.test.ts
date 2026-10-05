// ADR-0057, the unlock half. Normalizing fixes every vault made from now on;
// it does not open the ones already out there, whose key was derived from the
// exact string a device happened to produce. Those need a form the spec would
// never choose — and picking one is only allowed where there is something to
// verify it against, which is `verifyAccess()` reading the published manifest.

import { describe, expect, it } from "vitest";

import type { LogPort } from "@syncrypt/core";
import { createSyncEngine, isSyncError, SyncError } from "@syncrypt/core";
import {
  FixedClock,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "@syncrypt/core/testing";
import { openVaultCrypto } from "@syncrypt/crypto";

import { openSyncEngine } from "../src/index.js";

const COMPOSED = "passphrase café"; // é as one code point
const DECOMPOSED = "passphrase café"; // e + combining acute
const ASCII = "correct horse battery staple";
/** Mixed: café composed, résumé decomposed — all three forms differ. */
const MIXED = "caf\u00e9 re\u0301sume\u0301";

const TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

/**
 * A vault as a client before ADR-0057 would have left it: keys derived from
 * the passphrase exactly as the device produced it, with one file published.
 */
async function legacyVault(passphrase: string): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  const crypto = await openVaultCrypto({
    storage,
    storagePrefix: "",
    passphrase,
    defaults: TEST_PRESET,
    passphraseForm: "as-typed",
  });
  const vault = new MemoryVault();
  vault.setFile("note.md", "written before normalization existed");
  const engine = createSyncEngine({
    storage,
    vault,
    crypto,
    clock: new FixedClock(),
    state: new MemoryStateStore(),
    deviceId: "old-device",
    storagePrefix: "",
  });
  await engine.sync();
  return storage;
}

const withNote = (): MemoryVault => {
  const v = new MemoryVault();
  v.setFile("note.md", "something to publish");
  return v;
};

const open = (
  storage: MemoryStorage,
  passphrase: string,
  log?: LogPort,
  vault: MemoryVault = new MemoryVault(),
) =>
  openSyncEngine({
    storage,
    vault,
    passphrase,
    deviceId: "new-device",
    state: new MemoryStateStore(),
    clock: new FixedClock(),
    kdfDefaults: TEST_PRESET,
    ...(log !== undefined ? { log } : {}),
  });

describe("a vault created before the passphrase had a spelling", () => {
  it("OPENS, AND SAYS WHICH FORM OPENED IT", async () => {
    const storage = await legacyVault(DECOMPOSED);
    const log = new MemoryLog();

    // The same person, at the same device, typing the same characters.
    const engine = await open(storage, DECOMPOSED, log);

    const access = await engine.verifyAccess();
    expect(access?.files).toBe(1);
    expect(log.notices).toContainEqual({ code: "passphrase-legacy-form", form: "as-typed" });
  });

  it("OPENS FROM A DEVICE THAT COMPOSES, WHICH IS THE CASE THAT WAS BROKEN", async () => {
    // The vault holds the decomposed key; this device's keyboard produces the
    // composed characters. Before ADR-0057 this was "wrong passphrase", with
    // no way for the user to tell that it was not.
    const storage = await legacyVault(DECOMPOSED);
    const log = new MemoryLog();

    const engine = await open(storage, COMPOSED, log);

    expect((await engine.verifyAccess())?.files).toBe(1);
    expect(log.notices).toContainEqual({ code: "passphrase-legacy-form", form: "nfd" });
  });

  it("a vault written in the spec form is opened without any notice", async () => {
    const storage = new MemoryStorage();
    const first = await open(storage, DECOMPOSED, undefined, withNote());
    await first.sync();

    const log = new MemoryLog();
    const second = await open(storage, COMPOSED, log);
    expect((await second.verifyAccess())?.generation).toBeGreaterThan(0);
    expect(log.notices.filter((n) => n.code === "passphrase-legacy-form")).toEqual([]);
  });
});

describe("what the fallback must not do", () => {
  it("A WRONG PASSPHRASE IS STILL WRONG AFTER EVERY FORM", async () => {
    const storage = await legacyVault(DECOMPOSED);
    const engine = await open(storage, "complètement autre chose");
    await expect(engine.verifyAccess()).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
  });

  it("AN UNREACHABLE STORAGE IS NOT REPORTED AS A PASSPHRASE PROBLEM", async () => {
    const storage = await legacyVault(DECOMPOSED);
    const failing = Object.create(storage) as MemoryStorage & { get: unknown };
    let keyfileReads = 0;
    failing.get = async (key: string): Promise<Uint8Array> => {
      // The keyfile is readable; the manifest the probe wants is not.
      if (key.startsWith("manifests/")) {
        throw new SyncError("StorageTransient", "the bucket went away mid-unlock");
      }
      keyfileReads++;
      return await MemoryStorage.prototype.get.call(storage, key);
    };

    await expect(open(failing, COMPOSED)).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageTransient"),
    );
    // And it surfaces at once. One keyfile read is one derivation: a storage
    // failure must not be answered by grinding Argon2id through every form
    // before giving the same answer.
    expect(keyfileReads).toBe(1);
  });

  it("AN ASCII PASSPHRASE NEVER REACHES THE PROBE AT ALL", async () => {
    // The overwhelmingly common case must cost exactly what it did before:
    // no verifyAccess during open, so no manifest read.
    const storage = await legacyVault(ASCII); // "as-typed" === NFC here
    let manifestReads = 0;
    const counted = Object.create(storage) as MemoryStorage;
    counted.get = async (key: string): Promise<Uint8Array> => {
      if (key.startsWith("manifests/")) manifestReads++;
      return await MemoryStorage.prototype.get.call(storage, key);
    };

    const engine = await open(counted, ASCII);
    expect(manifestReads).toBe(0);

    // …and it is a perfectly ordinary vault once opened.
    expect((await engine.verifyAccess())?.files).toBe(1);
  });

  it("EACH CANDIDATE IS VERIFIED — THE FIRST ONE IS NOT ASSUMED", async () => {
    // Three distinct forms, and the vault holds the LAST of them. A fallback
    // that returns the first legacy candidate it can build hands back keys
    // that do not open this vault, and the failure looks like a wrong
    // passphrase again.
    expect(new Set([MIXED, MIXED.normalize("NFC"), MIXED.normalize("NFD")]).size).toBe(3);

    const storage = new MemoryStorage();
    const crypto = await openVaultCrypto({
      storage,
      storagePrefix: "",
      passphrase: MIXED,
      defaults: TEST_PRESET,
      passphraseForm: "nfd", // what a decomposing device produced
    });
    const vault = new MemoryVault();
    vault.setFile("note.md", "held under the decomposed key");
    await createSyncEngine({
      storage,
      vault,
      crypto,
      clock: new FixedClock(),
      state: new MemoryStateStore(),
      deviceId: "old-device",
      storagePrefix: "",
    }).sync();

    const log = new MemoryLog();
    const engine = await open(storage, MIXED, log);

    expect((await engine.verifyAccess())?.files).toBe(1);
    expect(log.notices).toContainEqual({ code: "passphrase-legacy-form", form: "nfd" });
  });

  it("a fresh vault is created in the spec form, whichever spelling made it", async () => {
    const storage = new MemoryStorage();
    const created = await open(storage, DECOMPOSED, undefined, withNote());
    await created.sync();

    // A second device, typing the composed characters, is an ordinary join —
    // no legacy form involved, because the vault was never written in one.
    const log = new MemoryLog();
    const joining = await open(storage, COMPOSED, log);
    expect(await joining.verifyAccess()).not.toBeNull();
    expect(log.notices.filter((n) => n.code === "passphrase-legacy-form")).toEqual([]);
  });
});
