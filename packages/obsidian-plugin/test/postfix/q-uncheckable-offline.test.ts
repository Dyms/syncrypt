// Post-fix review: ADR-0078 asks twice when nothing is published. The check
// lives inside verifyAccess's try, whose catch lets StorageTransient through
// as "offline, unlock anyway". A flaky link at that one read hands back the
// pre-ADR-0078 behaviour: a typo opens the vault, and its first push
// publishes the vault's first manifest under a key nobody else has.

import { beforeEach, describe, expect, it } from "vitest";

import { SyncError } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { UncheckablePassphrase } from "../../src/unlock-flow.js";
import { Notice, resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class FlakyList extends MemoryStorage {
  failManifestListOnce = false;
  override async *list(prefix: string) {
    if (this.failManifestListOnce && prefix.includes("manifests")) {
      this.failManifestListOnce = false;
      throw new SyncError("StorageTransient", "network blip");
    }
    yield* super.list(prefix);
  }
}

describe("Q3: ADR-0078 with a transient failure at verifyAccess (ADR-0081)", () => {
  it("a typo unlocked offline is checked before anything is published", async () => {
    const world = new World(() => new FlakyList());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    seed.plugin.lock();

    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "hello");
    (world.store("s3:https://s3.example.com/notes") as FlakyList).failManifestListOnce = true;
    // Offline at the check: the vault opens — the notes are local, and an
    // unreachable storage is no reason to refuse (RFC-0007)…
    await unlock(me.plugin, "plugin harness passphrasf");
    await settle(me.plugin);
    // …but the startup sync checked first, found nothing to check against,
    // and locked before any upload.
    expect(me.plugin.isUnlocked()).toBe(false);
    expect(Notice.shown).toContain(EN_STRINGS.notices.unlockRecheckUncheckable);
    const store = world.store("s3:https://s3.example.com/notes");
    expect(store.keys().some((k) => k.includes("manifests"))).toBe(false);
    // The seed, with the RIGHT passphrase, is not told it is wrong: the vault
    // still has nothing published, so it gets ADR-0078's question, as before.
    const seedAgain = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    await expect(unlock(seedAgain.plugin, PASS)).rejects.toBeInstanceOf(UncheckablePassphrase);
  });

  it("a passphrase confirmed by typing it twice is not asked again", async () => {
    const world = new World(() => new FlakyList());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    seed.plugin.lock();
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "hello");
    (world.store("s3:https://s3.example.com/notes") as FlakyList).failManifestListOnce = true;
    await (me.plugin as unknown as { unlock(p: string, c: boolean, k: boolean): Promise<void> })
      .unlock(PASS, false, true);
    await settle(me.plugin);
    expect(me.plugin.isUnlocked()).toBe(true);
    expect(world.store("s3:https://s3.example.com/notes").keys().some((k) => k.includes("manifests"))).toBe(true);
  });
});
