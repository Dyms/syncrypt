// ADR-0071: "Accept the storage as it is" checks the rollback at the moment of
// acceptance, in one queued step with forgetting the base. Audit №4 (B8): the
// check ran before the dialog; a storage that caught up while it was open
// (ADR-0038's eventually-consistent listing) was accepted anyway, and the
// base-less sync brought a local deletion back.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
  mainStore,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  World,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

async function behind(catchUpWhileOpen: boolean) {
  const world = new World();
  const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  for (let i = 0; i < 3; i++) {
    me.adapter.now += 1000;
    me.adapter.setFile(`n${String(i)}.md`, `v${String(i)}`);
    await engineOf(me).sync();
  }
  await me.adapter.remove("n0.md"); // deleted here, not synced yet
  const store = mainStore(world);
  const newest = store
    .keys()
    .filter((k) => k.includes("/manifests/"))
    .sort()
    .at(-1);
  if (newest === undefined) throw new Error("no manifest");
  const bytes = await store.get(newest);
  await store.delete(newest); // the listing misses the newest generation
  vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockImplementation(
    async () => {
      if (catchUpWhileOpen) await store.put(newest, bytes); // ...and catches up
      return true; // Accept
    },
  );
  return me;
}

describe("accepting a rolled-back storage (ADR-0071)", () => {
  it("a storage that caught up while the dialog was open is not accepted", async () => {
    const me = await behind(true);
    await me.plugin.acceptStorage();
    expect(Notice.shown).toContain(EN_STRINGS.notices.notRolledBack);
    expect(Notice.shown).not.toContain(EN_STRINGS.notices.storageAccepted);
    await me.plugin.syncNow("manual");
    expect(me.adapter.getText("n0.md")).toBeNull(); // the deletion stands
  });

  it("a storage still behind is accepted, and the sync that follows runs", async () => {
    const me = await behind(false);
    await me.plugin.acceptStorage();
    expect(Notice.shown).toContain(EN_STRINGS.notices.storageAccepted);
    expect((await engineOf(me).status()).baseGeneration).not.toBeNull(); // synced again
  });
});
