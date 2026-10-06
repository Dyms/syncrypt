// Fourth post-fix review (ADR-0084). Before it: failed.
// P1: the session engine keeps the storage wrapped by refusingWritesWhen(
// abandoned || unloaded) for its whole life. `abandoned` is set by close()
// while the dialog is busy — and the dialog stays busy after unlock() has
// already made the engine the session's (during the migration preflight).
// Closing the dialog then leaves an UNLOCKED session whose every put is
// refused: nothing this device writes is ever published until a re-lock.

import { beforeEach, describe, expect, it } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { Modal, resetStub, Setting } from "../support/obsidian-stub.js";
import { mainStore, makeDevice, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("P1: closing the dialog right after the engine was taken", () => {
  it("leaves no unlocked session that can never publish", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("mine.md", "local edit");

    // Hold the migration preflight (the first thing after `this.engine = engine`).
    const adapter = me.adapter as unknown as { exists(p: string): Promise<boolean> };
    const realExists = adapter.exists.bind(adapter);
    let release: () => void = () => undefined;
    let held = false;
    adapter.exists = (p: string) => {
      if (p.endsWith("community-plugins.json") && !held) {
        held = true;
        return new Promise<void>((r) => (release = r)).then(() => realExists(p));
      }
      return realExists(p);
    };

    Setting.rows = [];
    me.plugin.promptUnlock();
    const modal = Modal.opened.at(-1);
    const f = Setting.rows.find((r) => r.name === EN_STRINGS.unlockModal.passphrase)?.texts[0];
    if (modal === undefined || f === undefined) throw new Error("no dialog");
    await f.type(PASS);
    modal.contentEl.button(EN_STRINGS.unlockModal.unlock).click();
    await waitFor(() => held, "preflight reached");
    expect(me.plugin.isUnlocked()).toBe(true);
    modal.close(); // Escape, while the button still says "Checking…"
    release();
    await new Promise((r) => setTimeout(r, 200));
    await settle(me.plugin);

    // The session is open. A later sync must be able to publish.
    me.adapter.setFile("later.md", "written later in the session");
    await me.plugin.syncNow("manual");
    await settle(me.plugin);
    const manifestsByMe = mainStore(world)
      .keys()
      .filter((k) => k.includes("manifests/") && k.includes("dev-me"));
    expect(me.plugin.isUnlocked(), "session still open").toBe(true);
    expect(manifestsByMe.length, "an unlocked session that never publishes").toBeGreaterThan(0);
  });
});
