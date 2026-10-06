// Fifth post-fix review (ADR-0085). Before it: failed.
// Review5 V4: an unlock abandoned by closing its dialog (ADR-0082) returns
// without rendering the status. The status bar was set to "unlocking…" when
// the unlock started and stays so: a locked device saying it is unlocking,
// with nothing in flight, until something else happens to re-render it.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { Modal, resetStub, Setting } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

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

describe("V4: the status after an abandoned unlock", () => {
  it("does not keep saying 'unlocking'", async () => {
    const world = new World(() => new Gate());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    const store = world.store("s3:https://s3.example.com/notes") as Gate;

    Setting.rows = [];
    me.plugin.promptUnlock();
    const modal = Modal.opened.at(-1);
    const f = Setting.rows.find((r) => r.name === EN_STRINGS.unlockModal.passphrase)?.texts[0];
    if (modal === undefined || f === undefined) throw new Error("no dialog");
    await f.type(PASS);
    store.gated = true;
    modal.contentEl.button(EN_STRINGS.unlockModal.unlock).click();
    await waitFor(() => store.waiters.length > 0, "unlock reading the storage");
    modal.close(); // Escape while "Checking…"
    store.gated = false;
    for (const w of store.waiters.splice(0)) w();
    await new Promise((r) => setTimeout(r, 1500));
    expect(me.plugin.isUnlocked()).toBe(false);
    const statusEl = (me.plugin as unknown as { statusEl: { text: string } }).statusEl;
    expect(statusEl.text, "locked device showing 'unlocking…'").not.toBe(EN_STRINGS.status.unlocking);
  }, 10_000);
});
