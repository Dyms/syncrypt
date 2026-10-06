// Post-fix review: ADR-0066 §1 holds "the sync in flight" so lock() can abort
// it and unlock() can wait for it. The best-effort push on background (mobile
// visibilitychange) and on beforeunload is `void this.engine.push()` — not in
// `running`, no signal, `syncing` never set. Lock does not stop it, the next
// unlock does not wait for it: the C5 shape (two engines on one vault) again,
// and the orphan publishes a manifest with the keys Lock dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { Platform, Plugin, resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

class Slow extends MemoryStorage {
  delayMs = 0;
  override async put(...a: Parameters<MemoryStorage["put"]>) {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return super.put(...a);
  }
}

const handlers: { name: string; fn: () => void }[] = [];
beforeEach(() => {
  resetStub();
  handlers.length = 0;
  Platform.isMobile = true;
  vi.stubGlobal("document", { visibilityState: "hidden" });
  vi.spyOn(Plugin.prototype, "registerDomEvent").mockImplementation(((
    _el: unknown, name: string, fn: () => void,
  ) => { handlers.push({ name, fn }); }) as never);
});
afterEach(() => {
  Platform.isMobile = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Q: the background push is outside the lock boundary", () => {
  it("Lock does not stop it and the next unlock does not wait for it", async () => {
    const world = new World(() => new Slow());
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("seed.md", "seed");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const store = world.store("s3:https://s3.example.com/notes") as Slow;
    for (let i = 0; i < 8; i++) me.adapter.setFile(`n${String(i)}.md`, `edit ${String(i)}`);
    store.delayMs = 30;
    const hidden = handlers.find((h) => h.name === "visibilitychange");
    if (hidden === undefined) throw new Error("no visibilitychange handler");
    hidden.fn(); // app to background → push starts
    await new Promise((r) => setTimeout(r, 40));
    me.plugin.lock();
    const manifestsAtLock = store.keys().filter((k) => k.includes("/manifests/")).length;
    await new Promise((r) => setTimeout(r, 800));
    const manifestsAfter = store.keys().filter((k) => k.includes("/manifests/")).length;
    // Before ADR-0081: the orphaned push published after Lock.
    expect(manifestsAfter).toBe(manifestsAtLock);
  });
});
