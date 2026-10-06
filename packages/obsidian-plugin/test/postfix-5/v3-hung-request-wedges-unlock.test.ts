// Fifth post-fix review (ADR-0085). Before it: failed.
// Review5 V3 (ADR-0085: reads now end with the session; writes are waited for): one storage request that never answers (the transport has no
// timeout, and requestUrl cannot be aborted) keeps the locked session's sync
// "stopping" for ever. Every unlock after the Lock — or after any storage
// edit or ticket import, which lock on their own — waits 1 s for it and is
// refused with PreviousSessionBusy, however healthy the network is by then.
// The only way out is restarting Obsidian.

import { beforeEach, describe, expect, it } from "vitest";

import type { PutOptions } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { PreviousSessionBusy } from "../../src/unlock-error.js";
import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class HangGetOnce extends MemoryStorage {
  hangNextGet = false;
  hung = false;
  override get(key: string) {
    if (this.hangNextGet && key.includes("objects/")) {
      this.hangNextGet = false;
      this.hung = true;
      return new Promise<never>(() => undefined); // never answers
    }
    return super.get(key);
  }
}

class HangOnce extends MemoryStorage {
  hangNextPut = false;
  hung = false;
  override put(key: string, data: Uint8Array, opts?: PutOptions) {
    if (this.hangNextPut) {
      this.hangNextPut = false;
      this.hung = true;
      return new Promise<never>(() => undefined); // never answers
    }
    return super.put(key, data, opts);
  }
}

describe("V3: a request that never answers (ADR-0085)", () => {
  it("a hung READ does not refuse later unlocks: reads end with the session", async () => {
    const world = new World(() => new HangGetOnce());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    const store = world.store("s3:https://s3.example.com/notes") as HangGetOnce;
    store.hangNextGet = true;
    await unlock(me.plugin, PASS); // the startup pull downloads a.md and hangs
    await waitFor(() => store.hung, "the download hanging");
    me.plugin.lock();
    await unlock(me.plugin, PASS);
    expect(me.plugin.isUnlocked()).toBe(true);
    await settle(me.plugin);
    expect(me.adapter.getText("a.md")).toBe("a");
  }, 20_000);

  it("a hung WRITE is still waited for — refused, not opened beside it (known, ADR-0085)", async () => {
    const world = new World(() => new HangOnce());
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const store = world.store("s3:https://s3.example.com/notes") as HangOnce;
    me.adapter.setFile("b.md", "b");
    store.hangNextPut = true;
    void me.plugin.syncNow("manual");
    await waitFor(() => store.hung, "the upload hanging");
    me.plugin.lock();
    await expect(unlock(me.plugin, PASS)).rejects.toBeInstanceOf(PreviousSessionBusy);
  }, 20_000);
});
