// The shared Config Sync profile — ADR-0024.
//
// WHICH `.obsidian` files travel is a fact about the vault; it used to live in
// Syncrypt's own data.json, which never syncs (ADR-0016), so every device had
// to be ticked by hand and the profiles drifted. Drift is what produced the
// data-loss defect of ADR-0022, so the convergence path is worth pinning down.

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryStorage } from "@syncrypt/core/testing";

import {
  configPaths,
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_SYNC,
  type ConfigSyncSettings,
} from "../src/config-sync.js";
import {
  adoptSharedConfig,
  parseSharedConfig,
  serializeSharedConfig,
  sharedConfigMatches,
  sharedFrom,
  DEFAULT_SHARED_CONFIG_SYNC_PATH,
  type SharedConfigSync,
} from "../src/config-sync-file.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const on = (over: Partial<ConfigSyncSettings> = {}): ConfigSyncSettings => ({
  ...DEFAULT_CONFIG_SYNC,
  enabled: true,
  ...over,
});

/** Parse and assert readability in one step — an unreadable file is a failure. */
function parsed(text: string): SharedConfigSync {
  const shared = parseSharedConfig(text);
  if (shared === null) throw new Error(`unreadable shared config: ${text}`);
  return shared;
}

const P = configPaths(DEFAULT_CONFIG_DIR);

describe("what travels and what does not", () => {
  it("the shared file syncs on the master switch alone, with no category on", () => {
    const bare = on({
      appearance: false,
      app: false,
      hotkeys: false,
      themes: false,
      snippets: false,
      corePlugins: false,
      communityPluginsList: false,
      plugins: [],
    });
    // Otherwise a fresh device could never receive the profile it is supposed
    // to obey — it would have to be configured by hand first, which is the
    // whole problem.
    expect(P.allowed(DEFAULT_SHARED_CONFIG_SYNC_PATH, bare)).toBe(true);
    expect(P.allowed(".obsidian/appearance.json", bare)).toBe(false);
  });

  it("a device that has not opted in receives nothing, this file included", () => {
    expect(P.allowed(DEFAULT_SHARED_CONFIG_SYNC_PATH, DEFAULT_CONFIG_SYNC)).toBe(false);
  });

  it("the storage keys still never travel (ADR-0016)", () => {
    expect(P.allowed(".obsidian/plugins/syncrypt/data.json", on())).toBe(false);
  });

  it("the master switch is not in the file: opting in stays each device's own call", () => {
    const text = serializeSharedConfig(sharedFrom(on()));
    expect(text).not.toContain("enabled");
    const off: ConfigSyncSettings = { ...DEFAULT_CONFIG_SYNC, enabled: false };
    adoptSharedConfig(off, parsed(text));
    expect(off.enabled).toBe(false);
  });
});

describe("canonical serialization", () => {
  it("devices that agree produce byte-identical files, whatever the list order", () => {
    const a = on({ plugins: ["dataview", "obsidian42-brat", "calendar"] });
    const b = on({ plugins: ["calendar", "dataview", "obsidian42-brat"] });
    expect(serializeSharedConfig(sharedFrom(a))).toBe(serializeSharedConfig(sharedFrom(b)));
    // Identical bytes hash identically, so agreement costs no upload and two
    // devices publishing at once cannot conflict with each other.
  });

  it("round-trips, and an empty plugin list stays valid JSON", () => {
    for (const cs of [on(), on({ plugins: ["a", "b"] }), on({ app: true, themes: false })]) {
      const text = serializeSharedConfig(sharedFrom(cs));
      expect(() => JSON.parse(text) as unknown).not.toThrow();
      expect(sharedConfigMatches(cs, parsed(text))).toBe(true);
    }
  });

  it("an unreadable file changes nothing — it never resets settings to defaults", () => {
    expect(parseSharedConfig("")).toBeNull();
    expect(parseSharedConfig("{")).toBeNull();
    expect(parseSharedConfig("[]")).toBeNull();
    expect(parseSharedConfig('{"version":2,"categories":{},"plugins":[]}')).toBeNull();
    // A category missing entirely: refuse the whole file rather than read the
    // gap as "off" and silently stop syncing something.
    expect(parseSharedConfig('{"version":1,"categories":{"appearance":true},"plugins":[]}'))
      .toBeNull();
    const deduped = parsed(serializeSharedConfig(sharedFrom(on({ plugins: ["x", "x"] }))));
    expect(deduped.plugins).toEqual(["x"]);
  });
});

describe("adoption", () => {
  it("reports exactly what changed and flags secret-bearing plugins", () => {
    const local = on({ hotkeys: true, themes: true, plugins: ["calendar"] });
    const incoming = parsed(
      serializeSharedConfig(
        sharedFrom(on({ hotkeys: false, themes: true, plugins: ["dataview", "copilot"] })),
      ),
    );
    const result = adoptSharedConfig(local, incoming);
    expect(result.changed).toBe(true);
    expect(result.disabledCategories).toEqual(["hotkeys"]);
    expect(result.enabledCategories).toEqual([]);
    expect(result.addedPlugins).toEqual(["copilot", "dataview"]);
    expect(result.removedPlugins).toEqual(["calendar"]);
    expect(result.addedSecretBearing).toEqual(["copilot"]); // RFC-0008 rail 1
    expect(local.hotkeys).toBe(false);
    expect(local.plugins).toEqual(["copilot", "dataview"]);
  });

  it("adopting the same profile twice is a no-op, so devices cannot ping-pong", () => {
    const local = on({ plugins: ["dataview"] });
    const incoming = parsed(serializeSharedConfig(sharedFrom(local)));
    expect(adoptSharedConfig(local, incoming).changed).toBe(false);
  });
});

describe("a hostile or corrupt shared file", () => {
  // The file arrives from the vault. It is encrypted and authenticated, so it
  // comes from someone holding the passphrase — but it may also be an old
  // version, a hand-edit, or a device with a bug, so what it can DO matters.

  const hostile = (plugins: string[], over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 1,
      categories: {
        appearance: true,
        app: true,
        hotkeys: true,
        themes: true,
        snippets: true,
        corePlugins: true,
        communityPluginsList: true,
      },
      plugins,
      ...over,
    });

  it("cannot make Syncrypt's own data.json travel — the keys stay put (ADR-0016)", () => {
    const cs = on();
    adoptSharedConfig(cs, parsed(hostile(["syncrypt", "syncrypt-old", "syncrypt-1.0.0-beta.9"])));
    // Not even accepted into the list any more: the settings UI never renders
    // a Syncrypt folder, so an id that got in there could not be unticked by
    // the person it was done to (ADR-0042).
    expect(cs.plugins).toEqual([]);
    // And the list was never what protected them: the hard exclusion is first.
    expect(P.allowed(".obsidian/plugins/syncrypt/data.json", cs)).toBe(false);
    expect(P.allowed(".obsidian/plugins/syncrypt/sync-state.json", cs)).toBe(false);
    expect(P.allowed(".obsidian/plugins/syncrypt-old/data.json", cs)).toBe(false);
  });

  it("cannot escape the plugins folder with a crafted id", () => {
    const cs = on();
    adoptSharedConfig(
      cs,
      parsed(hostile(["../../..", "a/b", "/etc/passwd", "..", ".", "*"])),
    );
    for (const path of [
      ".obsidian/../../secrets.txt",
      ".obsidian/plugins/../../data.json",
      "/etc/passwd",
      ".obsidian/plugins/a/b/data.json",
      ".obsidian/plugins/anything/main.js",
      ".obsidian/plugins/anything/data.json",
    ]) {
      expect(P.allowed(path, cs), path).toBe(false);
    }
  });

  it("cannot re-enable the never-sync paths", () => {
    const cs = on();
    adoptSharedConfig(cs, parsed(hostile([])));
    for (const path of [
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/sync-trash/note.md",
    ]) {
      expect(P.allowed(path, cs), path).toBe(false);
    }
  });

  it("cannot switch config sync on for a device that never opted in", () => {
    const off: ConfigSyncSettings = { ...DEFAULT_CONFIG_SYNC, enabled: false };
    adoptSharedConfig(off, parsed(hostile(["dataview"])));
    expect(off.enabled).toBe(false);
    // Nothing is syncable while the master switch is off, the file included.
    expect(P.allowed(".obsidian/plugins/dataview/data.json", off)).toBe(false);
    expect(P.allowed(DEFAULT_SHARED_CONFIG_SYNC_PATH, off)).toBe(false);
  });

  it("an extra field it does not understand is ignored, not obeyed", () => {
    const cs = on({ plugins: [] });
    adoptSharedConfig(cs, parsed(hostile(["dataview"], { enabled: true, profile: { include: ["**"] } })));
    expect(cs.plugins).toEqual(["dataview"]);
    expect((cs as unknown as { profile?: unknown }).profile).toBeUndefined();
  });

  it("carries no secrets: only category booleans and plugin ids are serializable", () => {
    // The shape itself is the guarantee — sharedFrom reads ConfigSyncSettings,
    // which has no room for a credential. Pinned so a future field cannot
    // quietly widen it.
    const text = serializeSharedConfig(sharedFrom(on({ plugins: ["dataview"] })));
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["categories", "plugins", "version"]);
    for (const value of Object.values(raw.categories as Record<string, unknown>)) {
      expect(typeof value).toBe("boolean");
    }
    for (const secret of ["accessKey", "secretAccessKey", "passphrase", "endpoint", "bucket"]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

// --- end to end: the file actually crosses and the profiles converge --------

const PASSPHRASE = "shared config sync";
const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

async function makeDevice(
  storage: MemoryStorage,
  id: string,
  adapter: MockDataAdapter,
  configSync: ConfigSyncSettings,
) {
  adapter.folders.add(".obsidian");
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE, configSync),
    passphrase: PASSPHRASE,
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock: new FixedClock(),
    kdfDefaults: KDF_TEST_PRESET,
  });
  return { engine, adapter, configSync };
}

/** What the plugin does after each sync, without the Obsidian runtime. */
function reconcile(device: { adapter: MockDataAdapter; configSync: ConfigSyncSettings }): void {
  const text = device.adapter.getText(DEFAULT_SHARED_CONFIG_SYNC_PATH);
  if (text === null) {
    device.adapter.setFile(
      DEFAULT_SHARED_CONFIG_SYNC_PATH,
      serializeSharedConfig(sharedFrom(device.configSync)),
    );
    return;
  }
  const shared = parseSharedConfig(text);
  if (shared !== null) adoptSharedConfig(device.configSync, shared);
}

describe("two devices converge", () => {
  it("the phone adopts the desktop's profile and then carries the same files", async () => {
    const storage = new MemoryStorage();
    // The desktop opted dataview in; the phone has only the master switch.
    const desktop = await makeDevice(
      storage,
      "desktop",
      new MockDataAdapter(),
      on({ plugins: ["dataview"] }),
    );
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), on());

    desktop.adapter.setFile(".obsidian/plugins/dataview/data.json", '{"x":1}');
    reconcile(desktop); // publishes the shared profile
    await desktop.engine.sync();

    // Before adopting, the phone does not carry dataview's settings…
    await phone.engine.sync();
    expect(phone.adapter.getText(".obsidian/plugins/dataview/data.json")).toBeNull();
    // …but it did receive the profile, because that file rides on the master
    // switch alone.
    expect(phone.adapter.getText(DEFAULT_SHARED_CONFIG_SYNC_PATH)).not.toBeNull();

    reconcile(phone);
    expect(phone.configSync.plugins).toEqual(["dataview"]);

    // A vault adapter built from the adopted settings now agrees with the
    // desktop, and the next sync brings the file it was missing.
    const converged = await makeDevice(storage, "phone", phone.adapter, phone.configSync);
    await converged.engine.sync();
    expect(phone.adapter.getText(".obsidian/plugins/dataview/data.json")).toBe('{"x":1}');
  });

  it("the profile is stored as ciphertext like any other file, and the plugin list is not in the clear", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(
      storage,
      "desktop",
      new MockDataAdapter(),
      on({ plugins: ["dataview", "obsidian42-brat"] }),
    );
    reconcile(desktop);
    await desktop.engine.sync();

    for (const key of storage.keys()) {
      if (key.endsWith("keyfile-params.json")) continue;
      const bytes = await storage.get(key);
      expect(new TextDecoder().decode(bytes.subarray(0, 4)), key).toBe("SYNC");
      // Neither the file's name nor its contents are readable in the bucket.
      const whole = new TextDecoder().decode(bytes);
      expect(whole, key).not.toContain("syncrypt-config-sync");
      expect(whole, key).not.toContain("obsidian42-brat");
    }
  });

  it("a device that has not opted in never receives the profile at all", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(
      storage,
      "desktop",
      new MockDataAdapter(),
      on({ plugins: ["dataview"] }),
    );
    // Config sync off — the default.
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), {
      ...DEFAULT_CONFIG_SYNC,
    });

    desktop.adapter.setFile("note.md", "hello");
    reconcile(desktop);
    await desktop.engine.sync();
    await phone.engine.sync();

    expect(phone.adapter.getText("note.md")).toBe("hello"); // notes still sync
    expect(phone.adapter.getText(DEFAULT_SHARED_CONFIG_SYNC_PATH)).toBeNull();
    expect(phone.configSync.plugins).toEqual([]);
  });

  it("nobody's config files are deleted while the profiles still differ (ADR-0022)", async () => {
    const storage = new MemoryStorage();
    const desktop = await makeDevice(
      storage,
      "desktop",
      new MockDataAdapter(),
      on({ plugins: ["dataview"] }),
    );
    const phone = await makeDevice(storage, "phone", new MockDataAdapter(), on());

    desktop.adapter.setFile(".obsidian/plugins/dataview/data.json", '{"x":1}');
    reconcile(desktop);
    await desktop.engine.sync();
    await phone.engine.sync();
    await phone.engine.sync(); // a bogus tombstone would be published here
    await desktop.engine.sync();

    expect(desktop.adapter.getText(".obsidian/plugins/dataview/data.json")).toBe('{"x":1}');
  });
});
