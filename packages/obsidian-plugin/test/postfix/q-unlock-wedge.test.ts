// Post-fix review: ADR-0066 makes unlock() wait for the cancelled sync AND
// makes the passphrase dialog impossible to close while it "checks". The
// abort is only seen between operations, and requests carry no signal and no
// timeout. One request that hangs — the very case where someone fixes a dead
// endpoint in Settings, which locks — leaves an unclosable dialog.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { PassphraseModal } from "../../src/unlock.js";
import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class Hanging extends MemoryStorage {
  hang = false;
  override async *list(prefix: string) {
    if (this.hang) await new Promise(() => undefined); // a black-holed request
    yield* super.list(prefix);
  }
}

describe("Q: a hung request in the cancelled sync wedges the unlock dialog", () => {
  it("Lock → Unlock: the dialog neither opens the vault nor closes", async () => {
    const world = new World(() => new Hanging());
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);

    (world.store("s3:https://s3.example.com/notes") as Hanging).hang = true;
    void me.plugin.syncNow("manual"); // hangs inside a request
    await new Promise((r) => setTimeout(r, 50));
    me.plugin.lock(); // e.g. the endpoint field was edited (ADR-0065 §4)
    (world.store("s3:https://s3.example.com/notes") as Hanging).hang = false; // network is fine now

    me.plugin.promptUnlock();
    const modal = (me.plugin as unknown as { unlockModal: PassphraseModal }).unlockModal;
    (modal as unknown as { passphrase: string }).passphrase = PASS;
    void (modal as unknown as { submit(): Promise<void> }).submit();
    await new Promise((r) => setTimeout(r, 1500));
    modal.close(); // Escape / the X
    const state = {
      unlocked: me.plugin.isUnlocked(),
      dialogOpen: (modal as unknown as { isOpen: boolean }).isOpen,
    };
    // Before ADR-0081: { unlocked: false, dialogOpen: true } — and it stays so for as long as the request hangs.
    expect(state.unlocked || !state.dialogOpen).toBe(true);
  });
});
