// Review2 F7: Q7 (ADR-0081) holds maintenance commands in `chores` so Lock
// aborts them and the next unlock waits — but the long READ phases are called
// without the signal the engine accepts: previewReclaim(), listUncarried(),
// previewRelease() (main.ts reclaimWith / reviewManifest / releaseForgotten).
// Lock during "Reclaim storage"'s preview of a large bucket: the walk goes on,
// and every unlock for its whole duration is refused as PreviousSessionBusy.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { PreviousSessionBusy } from "../../src/unlock-error.js";
import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class SlowList extends MemoryStorage {
  delayMs = 0;
  override async *list(prefix: string) {
    for await (const item of super.list(prefix)) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      yield item;
    }
  }
}

describe("F7: Lock during a maintenance preview", () => {
  it("stops the preview, so the next unlock is not refused", async () => {
    const world = new World(() => new SlowList());
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    for (let i = 0; i < 40; i++) me.adapter.setFile(`n${String(i)}.md`, `note ${String(i)}`);
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const store = world.store("s3:https://s3.example.com/notes") as SlowList;
    store.delayMs = 60;
    void me.plugin.reclaimStorage();
    await new Promise((r) => setTimeout(r, 100)); // the preview is walking the bucket
    me.plugin.lock();
    store.delayMs = 60;
    let err: unknown = null;
    await unlock(me.plugin, PASS).catch((e: unknown) => { err = e; });
    expect(err instanceof PreviousSessionBusy, "unlock refused: the aborted chore's preview kept running").toBe(false);
    store.delayMs = 0;
  }, 20000);
});
