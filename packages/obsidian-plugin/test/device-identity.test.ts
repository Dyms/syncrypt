// ADR-0069: the device ID belongs to the installation, not to the folder.
// Audit №4 (A1/D4): a copied data.json cloned the ID; over WebDAV two devices
// with one ID published the same manifest key and one device's edit vanished.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { DEVICE_ID_KEY, resolveDeviceIdentity, type InstallStore } from "../src/device-identity.js";
import { EN_STRINGS } from "../src/i18n.js";
import { MockDataAdapter } from "./mock-adapter.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import { engineOf, makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

function store(initial: string | null = null): InstallStore & { value: string | null } {
  const s = {
    value: initial,
    load: () => s.value,
    save: (id: string) => {
      s.value = id;
    },
  };
  return s;
}
const gen = (): string => "dev-new";

describe("resolveDeviceIdentity", () => {
  it("the installation's own ID wins over data.json, and nothing is said", () => {
    const st = store("dev-mine");
    expect(resolveDeviceIdentity("dev-other", true, st, gen)).toEqual({
      deviceId: "dev-mine",
      installed: true,
      copied: false,
    });
  });

  it("an upgrade hands data.json's ID over and keeps it", () => {
    const st = store();
    expect(resolveDeviceIdentity("dev-old", false, st, gen)).toEqual({
      deviceId: "dev-old",
      installed: true,
      copied: false,
    });
    expect(st.value).toBe("dev-old");
  });

  it("a folder another installation owns gets a new ID, kept by this one", () => {
    const st = store();
    expect(resolveDeviceIdentity("dev-old", true, st, gen)).toEqual({
      deviceId: "dev-new",
      installed: true,
      copied: true,
    });
    expect(st.value).toBe("dev-new");
  });

  it("a first run generates once and hands it over", () => {
    const st = store();
    expect(resolveDeviceIdentity(undefined, false, st, gen).deviceId).toBe("dev-new");
    expect(st.value).toBe("dev-new");
  });

  it("an empty stored ID is no ID", () => {
    const st = store("");
    expect(resolveDeviceIdentity("dev-old", true, st, gen).copied).toBe(true);
  });

  it("without installation storage (Obsidian < 1.8.7) nothing changes", () => {
    expect(resolveDeviceIdentity("dev-old", true, null, gen)).toEqual({
      deviceId: "dev-old",
      installed: true,
      copied: false,
    });
    expect(resolveDeviceIdentity(undefined, false, null, gen).deviceId).toBe("dev-new");
  });
});

function cloneAdapter(a: MockDataAdapter): MockDataAdapter {
  const b = new MockDataAdapter();
  for (const f of a.folders) b.folders.add(f);
  for (const [k, v] of a.files) b.files.set(k, { data: v.data.slice(), mtime: v.mtime });
  b.now = a.now;
  return b;
}

const texts = (ad: MockDataAdapter): string[] =>
  [...ad.files.entries()]
    .filter(([k]) => !k.startsWith(".obsidian/"))
    .map(([, v]) => new TextDecoder().decode(v.data));

describe("a copied vault folder (ADR-0069)", () => {
  async function copied(world: World) {
    const installA = new Map<string, unknown>();
    const a = await makeDevice(world, structuredClone(S3_DATA), new MockDataAdapter(), installA);
    a.adapter.setFile("a.md", "base a");
    a.adapter.setFile("b.md", "base b");
    await unlock(a.plugin, PASS, true);
    await settle(a.plugin);
    // "Copy the vault folder to the laptop": notes, .obsidian, data.json, state.
    const data = structuredClone((a.plugin as unknown as { data: unknown }).data);
    const b = await makeDevice(world, data, cloneAdapter(a.adapter), new Map());
    return { a, b, installA };
  }

  it("the copy syncs under its own ID, and says so once", async () => {
    const { a, b } = await copied(new World());
    expect(b.plugin.settings.deviceId).not.toBe(a.plugin.settings.deviceId);
    expect(Notice.shown).toEqual([EN_STRINGS.notices.deviceCopied]);
  });

  it("over a backend without conditional writes both edits survive", async () => {
    const world = new World(() => new MemoryStorage({ conditionalWrites: false }));
    const { a, b } = await copied(world);
    await unlock(b.plugin);
    await settle(b.plugin);
    a.adapter.now += 60_000;
    b.adapter.now += 60_000;
    a.adapter.setFile("a.md", "EDIT FROM A");
    b.adapter.setFile("b.md", "EDIT FROM B");
    await Promise.all([engineOf(a).sync(), engineOf(b).sync()]);
    for (let i = 0; i < 3; i++) {
      a.adapter.now += 60_000;
      b.adapter.now += 60_000;
      await engineOf(a).sync();
      await engineOf(b).sync();
    }
    for (const side of [texts(a.adapter), texts(b.adapter)]) {
      expect(side).toContain("EDIT FROM A");
      expect(side).toContain("EDIT FROM B");
    }
  });

  it("the original keeps its ID on restart, and so does the copy", async () => {
    const world = new World();
    const { a, b, installA } = await copied(world);
    const again = await makeDevice(
      world,
      structuredClone((a.plugin as unknown as { data: unknown }).data),
      a.adapter,
      installA,
    );
    expect(again.plugin.settings.deviceId).toBe(a.plugin.settings.deviceId);
    expect(installA.get(DEVICE_ID_KEY)).toBe(a.plugin.settings.deviceId);
    expect(b.plugin.settings.deviceIdInstalled).toBe(true);
  });

  it("an upgraded device keeps the ID it had", async () => {
    const world = new World();
    const install = new Map<string, unknown>();
    const legacy = { ...structuredClone(S3_DATA), deviceId: "dev-legacy" }; // no flag yet
    const d = await makeDevice(world, legacy, new MockDataAdapter(), install);
    expect(d.plugin.settings.deviceId).toBe("dev-legacy");
    expect(install.get(DEVICE_ID_KEY)).toBe("dev-legacy");
    expect(Notice.shown).toEqual([]);
    const saved = (d.plugin as unknown as { data: { deviceIdInstalled?: boolean } }).data;
    expect(saved.deviceIdInstalled).toBe(true);
  });
});
