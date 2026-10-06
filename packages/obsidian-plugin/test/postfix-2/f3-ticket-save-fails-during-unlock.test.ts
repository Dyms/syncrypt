// Review2 F3: replaceSettings() mutates the settings IN PLACE, then awaits the
// write, and bumps `storageEpoch` only after the write succeeded. If the write
// FAILS it rolls the settings back and never bumps the epoch. An unlock that
// read part of its location inside that window (unlock() reads the state-file
// tag and openStorage() before an await, and storagePrefixOf(s) after it) is
// accepted by the Q6 epoch check: the engine runs on the ticket's prefix with
// the old location's state file, under settings that show the old location.

import { beforeEach, describe, expect, it } from "vitest";

import { LocationChanged } from "../../src/unlock-error.js";
import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("F3: a ticket whose settings write fails, during an unlock", () => {
  it("does not leave an engine on the ticket's location under the old settings", async () => {
    const world = new World();
    const auto = { autoSync: { enabled: false } };
    const seedA = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-sa" });
    seedA.adapter.setFile("a.md", "vault A");
    await unlock(seedA.plugin, PASS, true);
    await settle(seedA.plugin);
    const otherData = { ...S3_DATA, ...auto, s3: { ...S3_DATA.s3, prefix: "vaults/other" } };
    const seedB = await makeDevice(world, { ...otherData, deviceId: "dev-sb" });
    seedB.adapter.setFile("b-secret.md", "vault B only");
    await unlock(seedB.plugin, PASS, true);
    await settle(seedB.plugin);

    const me = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-me" });
    const p = me.plugin as unknown as {
      openStorage(): Promise<unknown>;
      saveData(d: unknown): Promise<void>;
    };
    const orig = p.openStorage.bind(me.plugin);
    let fired = false;
    p.openStorage = async () => {
      const s = await orig();
      if (!fired) {
        fired = true;
        // The disk write of the ticket's settings is slow and then fails.
        p.saveData = () => new Promise((_, rej) => setTimeout(() => { rej(new Error("EIO")); }, 20));
        const next = structuredClone(me.plugin.settings);
        next.s3.prefix = "vaults/other";
        void me.plugin.replaceSettings(next).catch(() => undefined);
      }
      return s;
    };
    await unlock(me.plugin, PASS).catch(() => undefined);
    await settle(me.plugin);
    expect(me.plugin.settings.s3.prefix).toBe("vaults/main"); // rolled back
    // Expected: either refused, or on vault A. Actual: vault B's file is here.
    expect(me.adapter.getText("b-secret.md"),
      "vault B synced under settings for vault A").toBeNull();
  });

  it("a ticket that IS saved during an unlock refuses the unlock (Q6, ADR-0082)", async () => {
    const world = new World();
    const auto = { autoSync: { enabled: false } };
    const seed = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-sa" });
    seed.adapter.setFile("a.md", "vault A");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    // A second vault in the same bucket — where the ticket points.
    const otherData = { ...S3_DATA, ...auto, s3: { ...S3_DATA.s3, prefix: "vaults/other" } };
    const seedB = await makeDevice(world, { ...otherData, deviceId: "dev-sb" });
    seedB.adapter.setFile("b.md", "vault B");
    await unlock(seedB.plugin, PASS, true);
    await settle(seedB.plugin);
    const me = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-me" });
    const p = me.plugin as unknown as { openStorage(): Promise<unknown> };
    const orig = p.openStorage.bind(me.plugin);
    let fired = false;
    p.openStorage = async () => {
      const s = await orig();
      if (!fired) {
        fired = true;
        const next = structuredClone(me.plugin.settings);
        next.s3.prefix = "vaults/other";
        void me.plugin.replaceSettings(next); // while Argon2id runs
      }
      return s;
    };
    const err = await unlock(me.plugin, PASS).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LocationChanged);
    expect(me.plugin.isUnlocked()).toBe(false);
  });

  it("a ticket locks an unlocked device before anything else (W3)", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const next = structuredClone(me.plugin.settings);
    next.s3.prefix = "vaults/other";
    await me.plugin.replaceSettings(next);
    expect(me.plugin.isUnlocked()).toBe(false);
  });

  it("an unlock that starts during a ticket's save waits for it (ADR-0082)", async () => {
    const world = new World();
    const auto = { autoSync: { enabled: false } };
    const seed = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-sa" });
    seed.adapter.setFile("a.md", "vault A");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const otherData = { ...S3_DATA, ...auto, s3: { ...S3_DATA.s3, prefix: "vaults/other" } };
    const seedB = await makeDevice(world, { ...otherData, deviceId: "dev-sb" });
    seedB.adapter.setFile("b-secret.md", "vault B only");
    await unlock(seedB.plugin, PASS, true);
    await settle(seedB.plugin);
    const me = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-me" });
    const p = me.plugin as unknown as { saveData(d: unknown): Promise<void> };
    // The write of the ticket's settings is slow and then fails: long enough
    // for an unlock to start on the ticket's location and derive its keys.
    p.saveData = () => new Promise((_, rej) => setTimeout(() => { rej(new Error("EIO")); }, 300));
    const next = structuredClone(me.plugin.settings);
    next.s3.prefix = "vaults/other";
    const replaced = me.plugin.replaceSettings(next).catch(() => undefined);
    const err = await unlock(me.plugin, PASS).then(() => null, (e: unknown) => e);
    await replaced;
    await settle(me.plugin);
    expect(me.plugin.settings.s3.prefix).toBe("vaults/main"); // rolled back
    // The unlock waited for the save, then opened the location the settings
    // name: vault A. Nothing of vault B came in.
    expect(err).toBeNull();
    expect(me.adapter.getText("b-secret.md")).toBeNull();
    expect(me.adapter.getText("a.md")).toBe("vault A");
  });
});
