// ADR-0065: the base belongs to one storage location, and an empty location
// is a question, not a new vault.
//
// One `sync-state.json` per Obsidian vault folder used to mean one base for
// every storage the folder was ever pointed at. A ticket for another vault, or
// a bucket retyped in Settings, opened the new storage with the old one's
// base — and a base from another vault plans that vault's files as edits to
// download over local notes (audit №4, D3). Separately, an empty location —
// one letter off in the prefix — became a second, empty vault in silence (W1).

import { beforeEach, describe, expect, it } from "vitest";

import { createConnectionTicket } from "@syncrypt/crypto";

import { EN_STRINGS } from "../src/i18n.js";
import { storageLocationOf, storageLocationTag, withDefaults } from "../src/settings.js";
import { UnlockFlow } from "../src/unlock-flow.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
  field,
  importTicket,
  makeDevice,
  PASS,
  renderTab,
  S3_DATA,
  saved,
  settle,
  unlock,
  World,
  type Device,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const at = (prefix: string) => ({ ...S3_DATA, s3: { ...S3_DATA.s3, prefix } });

async function pointAt(d: Device, prefix: string): Promise<void> {
  d.plugin.lock();
  d.plugin.settings.s3.prefix = prefix;
  await d.plugin.saveSettings();
}


describe("one base per storage location (ADR-0065, D3)", () => {
  it("another vault's base never plans a local note as an edit to overwrite", async () => {
    const world = new World();
    // Vault B, used for a while elsewhere; its old generations are pruned, so
    // nothing in it can answer for a generation number this device remembers.
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
    const store = world.store("s3:https://s3.example.com/notes");
    const manifestsOfB = store.keys().filter((k) => k.startsWith("vaults/b/manifests/"));
    expect(manifestsOfB.length).toBeLessThanOrEqual(3); // the early generations are gone

    // This device, on vault A, a few generations in.
    const me = await makeDevice(world, at("vaults/a"));
    me.adapter.setFile("Inbox.md", "A's inbox — my notes, written here");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    for (let i = 0; i < 2; i++) {
      me.adapter.now += 1000;
      me.adapter.setFile(`a${String(i)}.md`, `a ${String(i)}`);
      await engineOf(me).sync();
    }

    // Pointed at vault B.
    await pointAt(me, "vaults/b");
    await unlock(me.plugin);
    await settle(me.plugin);

    expect(me.adapter.getText("Inbox.md")).toBe("A's inbox — my notes, written here");
    const texts = [...me.adapter.files.values()].map((f) => new TextDecoder().decode(f.data));
    expect(texts).toContain("B's inbox — the other vault"); // beside it, as a conflict copy
  });

  it("going back to a location finds that location's own base", async () => {
    const world = new World();
    const me = await makeDevice(world, at("vaults/a"));
    me.adapter.setFile("note.md", "mine");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const generationA = (await engineOf(me).status()).baseGeneration;

    await pointAt(me, "vaults/b");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    for (let i = 0; i < 3; i++) {
      me.adapter.now += 1000;
      me.adapter.setFile(`more${String(i)}.md`, "only in b");
      await engineOf(me).sync(); // B's generation moves past A's
    }
    expect((await engineOf(me).status()).baseGeneration ?? 0).toBeGreaterThan(generationA ?? 0);

    await pointAt(me, "vaults/a");
    await unlock(me.plugin);
    expect((await engineOf(me).status()).baseGeneration).toBe(generationA);
  });

  it("the pre-ADR-0065 state file is adopted by the location in use, once", async () => {
    const world = new World();
    const me = await makeDevice(world, at("vaults/a"));
    me.adapter.setFile("note.md", "mine");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const tagged = `.obsidian/plugins/syncrypt/sync-state-${storageLocationTag(me.plugin.settings)}.json`;
    const legacy = ".obsidian/plugins/syncrypt/sync-state.json";
    // Make it look like an upgrade: the base sits under the old name.
    const blob = me.adapter.files.get(tagged);
    if (blob === undefined) throw new Error("no state file under the location's name");
    me.plugin.lock();
    me.adapter.files.delete(tagged);
    me.adapter.files.set(legacy, blob);

    // The upgrade: a new build loads over the same vault folder. The legacy
    // file is handed over at LOAD, to the location the settings name then.
    const data = structuredClone((me.plugin as unknown as { data: unknown }).data);
    const upgraded = await makeDevice(world, data, me.adapter);
    expect(me.adapter.files.has(legacy)).toBe(false);
    expect(me.adapter.files.has(tagged)).toBe(true);
    await unlock(upgraded.plugin);
    expect((await engineOf(upgraded).status()).baseGeneration).not.toBeNull();
  });

  it("names a location by where it points, not how it was typed", () => {
    const s = withDefaults(structuredClone(S3_DATA), { mobile: false });
    const same = withDefaults(
      {
        ...S3_DATA,
        s3: { ...S3_DATA.s3, endpoint: "HTTPS://S3.Example.com/", prefix: "vaults/main/", accessKeyId: "OTHER" },
      },
      { mobile: false },
    );
    const elsewhere = withDefaults(at("vaults/mai"), { mobile: false });
    const otherBucket = withDefaults({ ...S3_DATA, s3: { ...S3_DATA.s3, bucket: "notes2" } }, { mobile: false });
    expect(storageLocationOf(same)).toBe(storageLocationOf(s));
    expect(storageLocationTag(same)).toBe(storageLocationTag(s));
    for (const x of [elsewhere, otherBucket]) {
      expect(storageLocationTag(x)).not.toBe(storageLocationTag(s));
    }
  });
});

describe("an empty location is a question (ADR-0065, W1)", () => {
  it("unlocking a location with no vault creates nothing", async () => {
    const world = new World();
    const real = await makeDevice(world, at("vaults/main"));
    real.adapter.setFile("note.md", "the real vault");
    await unlock(real.plugin, PASS, true);
    await settle(real.plugin);

    // A second device, one letter off.
    const typo = await makeDevice(world, { ...at("vaults/mian"), deviceId: "dev-typo" });
    await expect(unlock(typo.plugin)).rejects.toMatchObject({ code: "VaultAbsent" });
    const store = world.store("s3:https://s3.example.com/notes");
    expect(store.keys().filter((k) => k.startsWith("vaults/mian"))).toEqual([]);
    expect(typo.plugin.isUnlocked()).toBe(false);
  });

  it("the dialog asks, takes the passphrase twice, and only then creates", async () => {
    const calls: [string, boolean][] = [];
    const open = (p: string, create: boolean): Promise<void> => {
      calls.push([p, create]);
      if (!create) return Promise.reject(Object.assign(new Error("absent"), { name: "SyncError" }));
      return Promise.resolve();
    };
    // A real SyncError, as the SDK throws it.
    const { SyncError } = await import("@syncrypt/core");
    const flow = new UnlockFlow(
      (p, create) =>
        create ? open(p, create) : (calls.push([p, create]), Promise.reject(new SyncError("VaultAbsent", "x"))),
      EN_STRINGS,
      "notes/vaults/new @ https://s3.example.com",
    );

    const first = await flow.submit("new passphrase");
    expect(first.kind).toBe("confirm-create");
    expect(first.kind === "confirm-create" && first.message).toContain("notes/vaults/new");
    expect(flow.creating).toBe(true);

    const mismatch = await flow.submit("new passphrasf");
    expect(mismatch).toEqual({ kind: "error", message: EN_STRINGS.unlockModal.createMismatch });
    expect(flow.creating).toBe(false);
    expect(calls.filter(([, c]) => c)).toEqual([]); // nothing created on a mismatch

    await flow.submit("new passphrase");
    const done = await flow.submit("new passphrase");
    expect(done).toEqual({ kind: "done" });
    expect(calls.filter(([, c]) => c)).toEqual([["new passphrase", true]]);
  });

  it("other failures are not turned into the question", async () => {
    const { SyncError } = await import("@syncrypt/core");
    const flow = new UnlockFlow(
      () => Promise.reject(new SyncError("CryptoAuthError", "no")),
      EN_STRINGS,
      "x",
    );
    expect(await flow.submit("p")).toEqual({
      kind: "error",
      message: EN_STRINGS.unlockModal.wrongPassphrase,
    });
    expect(flow.creating).toBe(false);
  });
});

describe("a changed connection is a reconnect (W2, W3)", () => {
  it("editing the bucket in Settings locks an unlocked device", async () => {
    const world = new World();
    const me = await makeDevice(world, at("vaults/main"));
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    renderTab(me);
    await field(EN_STRINGS.settings.bucket).type("notes2");
    expect(me.plugin.isUnlocked()).toBe(false);
    expect(Notice.shown).toContain(EN_STRINGS.notices.storageChangedLocked);
  });

  it("a ticket without keys, imported on an unlocked device, locks it — and the open tab edits the new settings", async () => {
    const world = new World();
    const me = await makeDevice(world, at("vaults/main"));
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    renderTab(me);

    const ticket = await createConnectionTicket(
      {
        provider: "s3",
        endpoint: "https://s3.new.example",
        region: "eu-central-1",
        bucket: "newbucket",
        prefix: "v",
        forcePathStyle: true,
      },
      PASS,
    );
    await importTicket(me, ticket);

    expect(me.plugin.isUnlocked()).toBe(false);
    expect(me.plugin.settings.s3.bucket).toBe("newbucket");
    // The tab re-rendered and its fields write to the live settings.
    expect(field(EN_STRINGS.settings.bucket).getValue()).toBe("newbucket");
    await field(EN_STRINGS.settings.accessKeyId).type("AKIANEW");
    expect(saved(me).s3.accessKeyId).toBe("AKIANEW");
  });
});

describe("adopting the old state file never overwrites a newer one", () => {
  it("leaves both alone when the location already has its own", async () => {
    const { adoptLegacyState } = await import("../src/state-store.js");
    const { MockDataAdapter } = await import("./mock-adapter.js");
    const adapter = new MockDataAdapter();
    adapter.setFile("p/sync-state.json", "old base");
    adapter.setFile("p/sync-state-abc.json", "newer base");
    await adoptLegacyState(adapter, "p/sync-state.json", "p/sync-state-abc.json");
    expect(adapter.getText("p/sync-state-abc.json")).toBe("newer base");
    expect(adapter.getText("p/sync-state.json")).toBe("old base");
  });
});
