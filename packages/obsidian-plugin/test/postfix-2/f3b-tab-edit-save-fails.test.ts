// Review2 F3b: the settings tab's storage fields mutate the settings, then
// await saveSettings(), and only THEN call storageSettingsChanged() (which
// bumps storageEpoch and locks). When the write fails, neither happens and the
// in-memory value is not rolled back: an unlocked engine keeps syncing the old
// location under settings (tab, Share, status) that show the new one — W2 /
// ADR-0065 §4 — and an unlock in flight passes the Q6 epoch check.

import { beforeEach, describe, expect, it } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { resetStub } from "../support/obsidian-stub.js";
import { field, makeDevice, PASS, renderTab, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("F3b: a storage edit whose save fails", () => {
  it("does not leave the engine on the old location under the new settings", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    renderTab(me);
    (me.plugin as unknown as { saveData(d: unknown): Promise<void> }).saveData = () =>
      Promise.reject(new Error("EIO"));
    await field(EN_STRINGS.settings.bucket).type("other-bucket").catch(() => undefined);
    const mismatch = me.plugin.isUnlocked() && me.plugin.settings.s3.bucket === "other-bucket";
    expect(mismatch, "unlocked on 'notes' while settings say 'other-bucket'").toBe(false);
  });
});
