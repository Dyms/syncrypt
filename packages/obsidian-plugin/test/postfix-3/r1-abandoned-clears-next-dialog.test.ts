// Review3 R1: an abandoned unlock, when it finally returns, runs the dialog
// callback's `this.unlockModal = null` — clearing the reference to the NEXT
// dialog the person already opened. The one-dialog rule (B11) and the unload
// dismissal (Q8) both read that field.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { PassphraseModal } from "../../src/unlock.js";
import { Modal, resetStub, Setting } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

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
  release(): void {
    this.gated = false;
    for (const w of this.waiters.splice(0)) w();
  }
}

async function submitIn(modal: Modal, pass: string): Promise<void> {
  const field = [...Setting.rows].reverse().find((r) => r.name === EN_STRINGS.unlockModal.passphrase)?.texts[0];
  if (field === undefined) throw new Error("no field");
  await field.type(pass);
  modal.contentEl.button(EN_STRINGS.unlockModal.unlock).click();
}

const passModals = (): Modal[] =>
  Modal.opened.filter((m) => (m as unknown) instanceof PassphraseModal && m.isOpen);

function lastModal(): Modal {
  const m = Modal.opened.at(-1);
  if (m === undefined) throw new Error("no dialog");
  return m;
}

async function setup() {
  const world = new World(() => new Gate());
  const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
  seed.adapter.setFile("a.md", "a");
  await unlock(seed.plugin, PASS, true);
  await settle(seed.plugin);
  const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
  const store = world.store("s3:https://s3.example.com/notes") as Gate;
  // Dialog 1: submitted, storage slow, closed while checking -> abandoned.
  Setting.rows = [];
  me.plugin.promptUnlock();
  const m1 = lastModal();
  store.gated = true;
  await submitIn(m1, PASS);
  await new Promise((r) => setTimeout(r, 50));
  m1.close();
  // Dialog 2: the person asks again.
  Setting.rows = [];
  me.plugin.promptUnlock();
  const m2 = lastModal();
  expect(m2).not.toBe(m1);
  // The abandoned unlock now finishes (returns: abandoned).
  store.release();
  await new Promise((r) => setTimeout(r, 300));
  return { world, me, store, m1, m2 };
}

describe("R1: abandoned unlock clears the next dialog's slot", () => {
  it("a second passphrase dialog can open beside the first (B11 rule broken)", async () => {
    const { me, m2 } = await setup();
    expect(m2.isOpen).toBe(true);
    expect(me.plugin.isUnlocked()).toBe(false);
    me.plugin.promptUnlock(); // e.g. Sync now / settings Unlock button
    expect(passModals().length, "two live passphrase dialogs").toBe(1);
  });

  it("unload leaves the live dialog on screen (Q8 regression)", async () => {
    const { me, m2 } = await setup();
    me.plugin.onunload();
    expect(m2.isOpen, "dialog outlives the unloaded instance").toBe(false);
  });
});
