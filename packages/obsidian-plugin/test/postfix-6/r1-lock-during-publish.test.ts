// Sixth post-fix review (ADR-0086). Before it: failed.
// Review 6 R1 (ADR-0085 abortingReadsOn): Lock while the manifest PUT of a
// push is in flight. The put is waited for and lands; the re-LIST that
// publishManifest runs right after it is a READ, and Lock rejects it as
// Aborted. The engine therefore never adopts the generation it just
// published: the device's base stays one generation behind its own
// publication. Before ADR-0085 the re-list completed and the base was adopted.
//
// Consequence: another device edits the same file on top of our publication;
// this device then plans base=old, local=our edit, remote=their edit — a
// conflict copy for nothing, and the other device's edit is NOT applied at
// the path (it should have been a clean download).

import { beforeEach, describe, expect, it } from "vitest";

import type { PutOptions } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, mainStore, PASS, S3_DATA, settle, unlock, waitFor, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class GateManifestPut extends MemoryStorage {
  gate = false;
  held: (() => void) | null = null;
  override put(key: string, data: Uint8Array, opts?: PutOptions) {
    if (this.gate && key.includes("manifests/")) {
      this.gate = false;
      return new Promise<void>((r) => (this.held = r)).then(() => super.put(key, data, opts));
    }
    return super.put(key, data, opts);
  }
}

describe("R1: Lock while a push's manifest put is in flight", () => {
  it("the generation that landed is adopted; a later remote edit downloads cleanly", async () => {
    const world = new World(() => new GateManifestPut());
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed", autoSync: { enabled: false } });
    seed.adapter.setFile("a.md", "a0");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...S3_DATA, deviceId: "dev-me", autoSync: { enabled: false } });
    await unlock(me.plugin, PASS);
    await settle(me.plugin);
    expect(me.adapter.getText("a.md")).toBe("a0");

    const store = mainStore(world) as GateManifestPut;
    me.adapter.now += 10;
    me.adapter.setFile("a.md", "a1");
    store.gate = true;
    void me.plugin.syncNow("manual");
    await waitFor(() => store.held !== null, "the manifest put in flight");
    me.plugin.lock();
    store.held?.();
    await waitFor(() => (me.plugin as unknown as { running: unknown }).running === null, "the locked sync stopping");

    // The publication landed.
    const keys: string[] = [];
    for await (const s of store.list("vaults/main/manifests/")) keys.push(s.key);
    expect(keys.some((k) => k.includes("000000002") && k.includes("dev-me"))).toBe(true);

    // The other device builds on it.
    await seed.plugin.syncNow("manual");
    await settle(seed.plugin);
    expect(seed.adapter.getText("a.md")).toBe("a1");
    seed.adapter.now += 10;
    seed.adapter.setFile("a.md", "b2");
    await seed.plugin.syncNow("manual");
    await settle(seed.plugin);

    await unlock(me.plugin, PASS);
    await settle(me.plugin);
    const copies = [...me.adapter.files.keys()].filter((p) => p.includes("conflict"));
    expect(copies, "a conflict copy of our own publication's successor").toEqual([]);
    expect(me.adapter.getText("a.md")).toBe("b2");
  }, 20_000);
});
