// Review3 R3: closing the dialog while "Create" is checking abandons the
// unlock (ADR-0082) — but openSyncEngine(createVault: true) runs on and
// writes the vault's keyfile parameters at the location regardless. The
// person dismissed the creation; the location is now a vault (its KDF profile
// fixed for good), and the next unlock there no longer asks "no vault here —
// create one?" (ADR-0065) but only to retype the passphrase.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { Modal, resetStub, Setting } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class Gate extends MemoryStorage {
  gated = false;
  waiters: (() => void)[] = [];
  override get(key: string) {
    if (!this.gated) return super.get(key);
    return new Promise<void>((r) => this.waiters.push(r)).then(() => super.get(key));
  }
}

describe("R3: an abandoned Create", () => {
  it("creates nothing at the location", async () => {
    const world = new World(() => new Gate());
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    const store = world.store("s3:https://s3.example.com/notes") as Gate;
    Setting.rows = [];
    me.plugin.promptUnlock();
    const modal = Modal.opened.at(-1);
    const f = Setting.rows.find((r) => r.name === EN_STRINGS.unlockModal.passphrase)?.texts[0];
    if (modal === undefined || f === undefined) throw new Error("no dialog");
    await f.type(PASS);
    modal.contentEl.button(EN_STRINGS.unlockModal.unlock).click();
    await new Promise((r) => setTimeout(r, 300)); // "No vault here — create?"
    await f.type(PASS);
    store.gated = true;
    modal.contentEl.button(EN_STRINGS.unlockModal.create).click();
    await new Promise((r) => setTimeout(r, 50));
    modal.close(); // the person changes their mind while it checks
    store.gated = false;
    for (const w of store.waiters.splice(0)) w();
    await new Promise((r) => setTimeout(r, 1000));
    expect(me.plugin.isUnlocked()).toBe(false);
    expect(store.keys().filter((k) => k.includes("keyfile")), "vault created after the dialog was dismissed").toEqual([]);
  });
});
