// Post-fix review: ADR-0065 §4 — "any storage edit on an unlocked device
// locks it". storageSettingsChanged() returns when not YET unlocked, and
// unlock() read the location (storage, state-file tag) before the seconds of
// Argon2id. An edit in that window — the Add-device path runs the unlock with
// no dialog over the freshly re-rendered settings tab — is saved and shown,
// while the engine assigned a moment later is bound to the old location. W2,
// back through the side door.

import { beforeEach, describe, expect, it } from "vitest";

import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("Q: a storage edit while an unlock is deriving keys", () => {
  it("leaves an engine on the old location under settings showing the new one", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    const p = me.plugin as unknown as { openStorage(): Promise<unknown> };
    const orig = p.openStorage.bind(me.plugin);
    let edited = false;
    p.openStorage = async () => {
      const s = await orig();
      if (!edited) {
        edited = true;
        // The person edits the bucket in the open tab while Argon2id runs.
        setTimeout(() => {
          me.plugin.settings.s3.bucket = "other-bucket";
          me.plugin.storageSettingsChanged();
        }, 0);
      }
      return s;
    };
    await me.plugin.connectWithPassphrase(PASS);
    await settle(me.plugin);
    expect(me.plugin.settings.s3.bucket).toBe("other-bucket");
    // Before ADR-0081: unlocked, syncing the old bucket; ADR-0065 §4 says it would be locked.
    expect(me.plugin.isUnlocked()).toBe(false);
  });
});
