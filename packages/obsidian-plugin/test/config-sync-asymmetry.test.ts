// What happens when devices DISAGREE about config sync — the realistic case:
// the desktop opted in, the phone has not (Syncrypt's own data.json never
// travels, so every device decides for itself).
//
// The dangerous shape would be: the phone downloads a config file it does not
// consider syncable, its next scan cannot see it, the engine reads that as a
// local deletion, and the desktop LOSES the file. This suite pins the
// behaviour down.

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryStorage } from "@syncrypt/core/testing";

import { DEFAULT_CONFIG_SYNC, type ConfigSyncSettings } from "../src/config-sync.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const PASSPHRASE = "config sync asymmetry";
const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

const CONFIG_ON: ConfigSyncSettings = { ...DEFAULT_CONFIG_SYNC, enabled: true };

async function makeDevice(
  storage: MemoryStorage,
  id: string,
  adapter: MockDataAdapter,
  configSync: ConfigSyncSettings,
) {
  adapter.folders.add(".obsidian");
  const clock = new FixedClock();
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE, configSync),
    passphrase: PASSPHRASE,
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock,
    kdfDefaults: KDF_TEST_PRESET,
  });
  return { engine, adapter, clock };
}

describe("desktop syncs config, phone does not", () => {
  it("the phone must not delete the desktop's config files", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(storage, "desktop", new MockDataAdapter(), CONFIG_ON);
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), DEFAULT_CONFIG_SYNC);

    desktop.adapter.setFile("note.md", "hello");
    desktop.adapter.setFile(".obsidian/appearance.json", '{"theme":"obsidian"}');
    desktop.adapter.setFile(".obsidian/snippets/mine.css", "body{}");
    await desktop.engine.sync();

    // The phone syncs twice: once to pull, once so any bogus "local deletion"
    // it inferred would be pushed.
    await phone.engine.sync();
    await phone.engine.sync();

    // …and the desktop syncs again, which is where a tombstone would land.
    await desktop.engine.sync();

    expect(desktop.adapter.getText(".obsidian/appearance.json")).toBe('{"theme":"obsidian"}');
    expect(desktop.adapter.getText(".obsidian/snippets/mine.css")).toBe("body{}");
    expect(desktop.adapter.getText("note.md")).toBe("hello");
  });

  it("the phone gets the notes either way", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(storage, "desktop", new MockDataAdapter(), CONFIG_ON);
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), DEFAULT_CONFIG_SYNC);

    desktop.adapter.setFile("note.md", "hello");
    desktop.adapter.setFile(".obsidian/appearance.json", "{}");
    await desktop.engine.sync();
    await phone.engine.sync();

    expect(phone.adapter.getText("note.md")).toBe("hello");
  });
});

describe("both devices sync config", () => {
  it("config files travel like any other file", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(storage, "desktop", new MockDataAdapter(), CONFIG_ON);
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), CONFIG_ON);

    desktop.adapter.setFile(".obsidian/appearance.json", '{"theme":"moonstone"}');
    desktop.adapter.setFile(".obsidian/plugins/dataview/data.json", '{"x":1}');
    await desktop.engine.sync();
    await phone.engine.sync();

    expect(phone.adapter.getText(".obsidian/appearance.json")).toBe('{"theme":"moonstone"}');
    // dataview is NOT in configSync.plugins on either side → its settings stay put.
    expect(phone.adapter.getText(".obsidian/plugins/dataview/data.json")).toBeNull();
  });

  it("an opted-in plugin's settings do travel", async () => {
    const storage = new MemoryStorage();
    const withPlugin: ConfigSyncSettings = { ...CONFIG_ON, plugins: ["dataview"] };
    const desktop = await makeDevice(storage, "desktop", new MockDataAdapter(), withPlugin);
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), withPlugin);

    desktop.adapter.setFile(".obsidian/plugins/dataview/data.json", '{"x":1}');
    await desktop.engine.sync();
    await phone.engine.sync();

    expect(phone.adapter.getText(".obsidian/plugins/dataview/data.json")).toBe('{"x":1}');
  });
});

describe("the same asymmetry with an ordinary sync profile", () => {
  it("a device that excludes PDFs must not delete them for everyone else", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(storage, "desktop", new MockDataAdapter(), DEFAULT_CONFIG_SYNC);
    // The phone saves space: no PDFs.
    const phoneAdapter = new MockDataAdapter();
    phoneAdapter.folders.add(".obsidian");
    const phone = {
      adapter: phoneAdapter,
      engine: await openSyncEngine({
        storage,
        vault: new ObsidianVault(
          phoneAdapter,
          { include: ["**"], exclude: [".*", ".*/**", "**/*.pdf"] },
          DEFAULT_CONFIG_SYNC,
        ),
        passphrase: PASSPHRASE,
        deviceId: "phone",
        state: new AdapterStateStore(phoneAdapter),
        clock: new FixedClock(),
        kdfDefaults: KDF_TEST_PRESET,
      }),
    };

    desktop.adapter.setFile("note.md", "hello");
    desktop.adapter.setFile("papers/thesis.pdf", "%PDF-1.7 …");
    await desktop.engine.sync();

    await phone.engine.sync();
    await phone.engine.sync();
    await desktop.engine.sync();

    expect(desktop.adapter.getText("papers/thesis.pdf")).toBe("%PDF-1.7 …");
  });
});
