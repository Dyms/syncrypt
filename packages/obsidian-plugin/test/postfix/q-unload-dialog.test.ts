// Post-fix review: lock() closes every dialog opened through ask(), but the
// passphrase dialog is held in `unlockModal`, outside openModals, and
// onunload() is just lock(). A plugin reloaded (update, disable/enable) while
// the startup prompt is up leaves that dialog on screen, bound to the unloaded
// instance; answering it opens an engine, a scheduler and a startup sync
// that no unload will ever stop — beside the new instance's own.

import { beforeEach, describe, expect, it } from "vitest";

import { PassphraseModal } from "../../src/unlock.js";
import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("Q: unload with the passphrase dialog open", () => {
  it("the dialog survives the unload and unlocks the dead instance", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.plugin.promptUnlock(); // the startup prompt
    const modal = (me.plugin as unknown as { unlockModal: PassphraseModal }).unlockModal;
    me.plugin.onunload(); // plugin updated / disabled
    const openAfterUnload = (modal as unknown as { isOpen: boolean }).isOpen;
    (modal as unknown as { passphrase: string }).passphrase = PASS;
    await (modal as unknown as { submit(): Promise<void> }).submit();
    await settle(me.plugin);
    // Before ADR-0081: { openAfterUnload: true, unlockedAfterUnload: true }
    expect({ openAfterUnload, unlockedAfterUnload: me.plugin.isUnlocked() }).toEqual({
      openAfterUnload: false,
      unlockedAfterUnload: false,
    });
  });

  it("an unlock already deriving keys at unload opens nothing", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.plugin.promptUnlock();
    const modal = (me.plugin as unknown as { unlockModal: PassphraseModal }).unlockModal;
    (modal as unknown as { passphrase: string }).passphrase = PASS;
    const submitted = (modal as unknown as { submit(): Promise<void> }).submit(); // Argon2id running
    me.plugin.onunload();
    await submitted;
    await settle(me.plugin);
    expect({
      open: (modal as unknown as { isOpen: boolean }).isOpen,
      unlocked: me.plugin.isUnlocked(),
    }).toEqual({ open: false, unlocked: false });
  });
});
