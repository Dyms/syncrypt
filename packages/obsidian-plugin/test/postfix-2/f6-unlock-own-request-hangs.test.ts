// Review2 F6: Q4 (ADR-0081) bounds only the wait for the PREVIOUS session.
// A request of the unlock itself that never returns (no transport timeout:
// obsidian-transport/S3 retry have none) still holds the passphrase dialog on
// "Checking…": PassphraseModal.close() refuses while busy (B14), and nothing
// else ends the attempt short of unloading the plugin. The same dead link that
// made the previous sync hang makes this one hang.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { Modal, resetStub, Setting } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class Hang extends MemoryStorage {
  hang = false;
  override get(key: string) {
    if (this.hang) return new Promise<Uint8Array>(() => undefined);
    return super.get(key);
  }
}

describe("F6: the unlock's own request hangs", () => {
  it("the passphrase dialog can still be closed", async () => {
    const world = new World(() => new Hang());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    (world.store("s3:https://s3.example.com/notes") as Hang).hang = true;
    Setting.rows = [];
    me.plugin.promptUnlock();
    const modal = Modal.opened.at(-1);
    const field = Setting.rows.find((r) => r.name === EN_STRINGS.unlockModal.passphrase)?.texts[0];
    if (modal === undefined || field === undefined) throw new Error("no dialog");
    await field.type(PASS);
    modal.contentEl.button(EN_STRINGS.unlockModal.unlock).click();
    await new Promise((r) => setTimeout(r, 1500)); // well past PREVIOUS_SESSION_WAIT_MS
    modal.close(); // Escape / the X
    expect(modal.isOpen, "dialog wedged on Checking… with no way to close it").toBe(false);
  });
});
