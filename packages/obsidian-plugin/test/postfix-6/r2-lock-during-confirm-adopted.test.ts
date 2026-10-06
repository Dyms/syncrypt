// Sixth post-fix review (ADR-0086). Before it: failed.
// Review 6 R2 (core confirmAdopted, made worse by ADR-0085): Lock while a
// push re-checks the objects its dedup probe adopted. confirmAdopted
// `continue`s past ANY error that is not StorageNotFound — the session-ended
// Aborted included — then sees the signal and RETURNS normally. applyPushOps
// computed `aborted` before it, so doPush builds and PUBLISHES a manifest
// after the Lock (puts are not refused once the engine is taken). With
// ADR-0085 the re-list after that put is also aborted, so the generation
// that was published after Lock is not even adopted as base (see R1).

import { beforeEach, describe, expect, it } from "vitest";

import type { ObjectStat } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, mainStore, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class GateSecondObjectStat extends MemoryStorage {
  armed = false;
  seen = 0;
  held: (() => void) | null = null;
  override stat(key: string): Promise<ObjectStat> {
    if (this.armed && key.includes("objects/")) {
      this.seen++;
      if (this.seen === 2) {
        this.armed = false;
        return new Promise<void>((r) => (this.held = r)).then(() => super.stat(key));
      }
    }
    return super.stat(key);
  }
}

describe("R2: Lock during the adopted-object re-check", () => {
  it("publishes nothing after Lock", async () => {
    const world = new World(() => new GateSecondObjectStat());
    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "same bytes");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const store = mainStore(world) as GateSecondObjectStat;
    const manifests = async (): Promise<string[]> => {
      const out: string[] = [];
      for await (const s of store.list("vaults/main/manifests/")) out.push(s.key);
      return out.sort();
    };
    const before = await manifests();

    // Same content as a.md: the dedup probe adopts the stored object.
    me.adapter.now += 10;
    me.adapter.setFile("c.md", "same bytes");
    store.armed = true;
    void me.plugin.syncNow("manual");
    await waitFor(() => store.held !== null, "the confirmAdopted stat in flight");
    me.plugin.lock();
    store.held?.();
    await waitFor(() => (me.plugin as unknown as { running: unknown }).running === null, "the locked sync stopping");

    expect(await manifests(), "a generation published after Lock").toEqual(before);
  }, 20_000);
});
