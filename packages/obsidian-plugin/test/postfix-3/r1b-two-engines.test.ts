// Review3 R1b (ADR-0083): two unlocks in flight at once. The second passed
// previousSessionStopped() before the first even had a session; a Lock in
// between ends the first session, and the second took the engine while the
// first session's sync was still running — two engines on one vault
// (ADR-0066). (Found through R1's second dialog; R1 is closed, the wait
// before taking the engine closes the rest.)

import { beforeEach, describe, expect, it } from "vitest";

import type { PutOptions } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class Gate extends MemoryStorage {
  getGated = false;
  putGated = false;
  getWaiters: (() => void)[] = [];
  putWaiters: (() => void)[] = [];
  override get(key: string) {
    if (!this.getGated) return super.get(key);
    return new Promise<void>((r) => this.getWaiters.push(r)).then(() => super.get(key));
  }
  override put(key: string, data: Uint8Array, opts?: PutOptions) {
    if (!this.putGated) return super.put(key, data, opts);
    return new Promise<void>((r) => this.putWaiters.push(r)).then(() => super.put(key, data, opts));
  }
}

describe("R1b: two live dialogs -> two engines on one vault", () => {
  it("an unlock started before a Lock opens beside the locked session's running sync", async () => {
    const world = new World(() => new Gate());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("mine.md", "local edit");
    const store = world.store("s3:https://s3.example.com/notes") as Gate;

    // Two unlocks in flight at once (a dialog and an Add-device connect, say),
    // both held at their first request while the storage is slow.
    const open = (me.plugin as unknown as { unlock(p: string): Promise<void> }).unlock.bind(me.plugin);
    store.getGated = true;
    const u3 = open(PASS).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const u3Waiter = store.getWaiters.splice(0);
    const u2 = open(PASS).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    // U2 goes on; U3 stays held at its first request.
    store.getGated = false;
    store.putGated = true; // the startup sync's upload will hang a while
    for (const w of store.getWaiters.splice(0)) w();
    await u2;
    await waitFor(() => me.plugin.isUnlocked(), "U2 unlocked");
    await waitFor(() => store.putWaiters.length > 0, "S2 uploading");
    const oldRun = (me.plugin as unknown as { running: { done: Promise<void> } }).running;
    let oldDone = false;
    void oldRun.done.then(() => (oldDone = true));

    me.plugin.lock();
    // U3 goes on now.
    for (const w of u3Waiter) w();
    await u3;
    const twoEngines = me.plugin.isUnlocked() && !oldDone;
    store.putGated = false;
    for (const w of store.putWaiters.splice(0)) w();
    await settle(me.plugin);
    expect(twoEngines, "new engine opened while the locked session's sync still ran").toBe(false);
  });
});

describe("two unlocks at once while the first one's startup sync is slow", () => {
  it("the second returns: the open session stands, nothing to wait for (ADR-0083)", async () => {
    const world = new World(() => new Gate());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("mine.md", "local edit");
    const store = world.store("s3:https://s3.example.com/notes") as Gate;
    const open = (me.plugin as unknown as { unlock(p: string): Promise<void> }).unlock.bind(me.plugin);
    store.getGated = true;
    const u1 = open(PASS);
    await new Promise((r) => setTimeout(r, 50));
    const firstWaiters = store.getWaiters.splice(0);
    const u2 = open(PASS);
    await new Promise((r) => setTimeout(r, 50));
    const secondWaiters = store.getWaiters.splice(0);
    store.getGated = false;
    store.putGated = true; // u1's startup sync will hang on its upload
    for (const w of firstWaiters) w();
    await u1;
    await waitFor(() => store.putWaiters.length > 0, "the startup sync uploading");
    for (const w of secondWaiters) w();
    await expect(u2).resolves.toBeUndefined();
    store.putGated = false;
    for (const w of store.putWaiters.splice(0)) w();
    await settle(me.plugin);
  });
});

