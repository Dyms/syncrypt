// Fifth post-fix review (ADR-0085). Before it: failed.
// Review5 V2: Lock does not reach an unlock in flight. The Add-device connect
// (connectWithPassphrase) runs an unlock with no dialog to close — the status
// bar says "Unlocking…". The person runs "Lock" meanwhile; the unlock goes on,
// takes the engine after the Lock and starts the on-open sync: an engine that
// outlives the Lock that was asked for. (`abandoned` covers only the dialog;
// Lock bumps `session`, which the unlock never looks at.)

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { resetStub } from "../support/obsidian-stub.js";
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

describe("V2: Lock while an unlock is in flight", () => {
  it("leaves the device locked", async () => {
    const world = new World(() => new Gate());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    const store = world.store("s3:https://s3.example.com/notes") as Gate;
    store.gated = true;
    const connecting = me.plugin.connectWithPassphrase(PASS);
    await waitFor(() => store.waiters.length > 0, "unlock reading the storage");
    me.plugin.lock(); // the Lock command, while the status bar says "Unlocking…"
    store.gated = false;
    for (const w of store.waiters.splice(0)) w();
    await connecting;
    await settle(me.plugin);
    expect(me.plugin.isUnlocked(), "an engine opened after Lock").toBe(false);
  });
});
