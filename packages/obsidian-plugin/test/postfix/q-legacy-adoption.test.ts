// Post-fix review: ADR-0065 §2 adopts the pre-ADR-0065 sync-state.json into
// the location in use "at the first unlock", and ADR-0079 adopts state with no
// vault identity as-is. The ADR says the leftover risk is someone who "changed
// storage and upgraded before unlocking". The common order is the other one:
// the build updates, Obsidian restarts, and the first thing done is Add
// device with a ticket for ANOTHER vault. The ticket's location is "in use" at
// that first unlock, so vault A's base is renamed to vault B's file — D3 in
// full: B's version downloaded over A's note, no copy, no trash.

import { beforeEach, describe, expect, it } from "vitest";

import { createConnectionTicket } from "@syncrypt/crypto";

import { storageLocationTag } from "../../src/settings.js";
import { resetStub } from "../support/obsidian-stub.js";
import {
  engineOf,
  importTicket,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  World,
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const at = (prefix: string) => ({ ...S3_DATA, s3: { ...S3_DATA.s3, prefix } });

describe("Q: upgrade, then a ticket for another vault before the first unlock", () => {
  it("vault A's legacy base is handed to vault B and B's note overwrites A's", async () => {
    const world = new World();
    // Vault B, long-lived, its early generations pruned (as in the D3 test).
    const other = await makeDevice(world, {
      ...at("vaults/b"),
      deviceId: "dev-other",
      safeSync: { generationsToKeep: 2 },
    });
    await unlock(other.plugin, PASS, true);
    await settle(other.plugin);
    other.adapter.setFile("Inbox.md", "B's inbox — the other vault");
    for (let i = 0; i < 8; i++) {
      other.adapter.now += 1000;
      other.adapter.setFile(`b${String(i)}.md`, `b ${String(i)}`);
      await engineOf(other).sync();
    }
    await engineOf(other).reclaimStorage();

    // This device on vault A under the previous build.
    const me = await makeDevice(world, at("vaults/a"));
    me.adapter.setFile("Inbox.md", "A's inbox — my notes, written here");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    for (let i = 0; i < 2; i++) {
      me.adapter.now += 1000;
      me.adapter.setFile(`a${String(i)}.md`, `a ${String(i)}`);
      await engineOf(me).sync();
    }
    me.plugin.lock();
    // ...as a beta.12 state file: one name, no vault identity.
    const dir = ".obsidian/plugins/syncrypt";
    const tagged = `${dir}/sync-state-${storageLocationTag(me.plugin.settings)}.json`;
    const blob = me.adapter.files.get(tagged);
    if (blob === undefined) throw new Error("no state");
    const state = JSON.parse(new TextDecoder().decode(blob.data)) as Record<string, unknown>;
    delete state.vault;
    me.adapter.files.delete(tagged);
    me.adapter.setFile(`${dir}/sync-state.json`, JSON.stringify(state));

    // The new build starts; before any unlock, the person adds the device to B.
    const s3 = { ...S3_DATA.s3, prefix: "vaults/b" };
    const ticket = await createConnectionTicket({ provider: "s3", ...s3 }, PASS);
    await importTicket(me, ticket, PASS);
    await settle(me.plugin);
    expect(me.plugin.isUnlocked()).toBe(true);
    // Before ADR-0081: B's inbox is now at the path; A's text is nowhere (no conflict copy).
    const texts = [...me.adapter.files.values()].map((f) => new TextDecoder().decode(f.data));
    expect(texts).toContain("A's inbox — my notes, written here");
  });
});
