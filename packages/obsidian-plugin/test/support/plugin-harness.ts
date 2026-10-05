// A real SyncryptPlugin, loaded through the obsidian stub, over a mock vault.
//
// Storage is "where the settings point": every distinct provider + endpoint +
// bucket is its own MemoryStorage, so pointing the settings somewhere else
// really reaches different objects, and a prefix is honoured by the engine as
// it is against a real bucket. Only `openStorage` is replaced; unlock, the
// engine, the state file and the settings tab are the production code.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
   -- the one place tests reach the plugin's private state; typed helpers out. */

import type { SyncEngine } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import SyncryptPlugin from "../../src/main.js";
import type { SyncryptSettings } from "../../src/settings.js";
import type { SyncryptSettingTab } from "../../src/settings-tab.js";
import { MockDataAdapter } from "../mock-adapter.js";
import { AddDeviceModal } from "../../src/ticket-modals.js";
import { Setting, type TextComponent } from "./obsidian-stub.js";

export const PASS = "plugin harness passphrase";

/** Every storage a test's devices can be pointed at. */
export class World {
  readonly stores = new Map<string, MemoryStorage>();
  constructor(
    private readonly make: () => MemoryStorage = () => new MemoryStorage(),
  ) {}
  store(key: string): MemoryStorage {
    let s = this.stores.get(key);
    if (s === undefined) {
      s = this.make();
      this.stores.set(key, s);
    }
    return s;
  }
}

/** The one storage every S3_DATA-based device of a test reaches. */
export function mainStore(world: World): MemoryStorage {
  return world.store("s3:https://s3.example.com/notes");
}

/** Poll until `ok()` holds (a background sync, a dialog opening). */
export async function waitFor(ok: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const S3_DATA = {
  provider: "s3",
  s3: {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "notes",
    prefix: "vaults/main",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret-example",
    forcePathStyle: true,
  },
  deviceId: "dev-aaaa",
};

export interface Device {
  plugin: SyncryptPlugin;
  adapter: MockDataAdapter;
  app: any;
}

export async function makeDevice(
  world: World,
  data: unknown,
  adapter = new MockDataAdapter(),
  /** This installation's vault-scoped localStorage; absent = Obsidian < 1.8.7. */
  install?: Map<string, unknown>,
): Promise<Device> {
  adapter.folders.add(".obsidian");
  adapter.folders.add(".obsidian/plugins");
  adapter.folders.add(".obsidian/plugins/syncrypt");
  const app: any = {
    vault: {
      adapter,
      configDir: ".obsidian",
      on: () => ({}),
      offref: () => undefined,
    },
    workspace: { onLayoutReady: () => undefined, getLeavesOfType: () => [] },
  };
  if (install !== undefined) {
    app.loadLocalStorage = (k: string) => install.get(k) ?? null;
    app.saveLocalStorage = (k: string, v: unknown) => {
      if (v === null) install.delete(k);
      else install.set(k, v);
    };
  }
  const plugin = new SyncryptPlugin(app, {
    id: "syncrypt",
    version: "1.0.0-test",
    dir: ".obsidian/plugins/syncrypt",
  } as any);
  (plugin as any).data = structuredClone(data);
  (plugin as any).openStorage = () => {
    const s = plugin.settings;
    const key =
      s.provider === "webdav" ? `dav:${s.webdav.url}` : `s3:${s.s3.endpoint}/${s.s3.bucket}`;
    return Promise.resolve(world.store(key));
  };
  await plugin.onload();
  return { plugin, adapter, app };
}

/** The private unlock, as the passphrase dialog calls it. */
export function unlock(plugin: SyncryptPlugin, pass = PASS, create = false): Promise<void> {
  return (plugin as any).unlock(pass, create);
}

/** Wait until the background sync an unlock started has finished. */
export async function settle(plugin: SyncryptPlugin): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (!(plugin as any).syncing) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("sync did not settle");
}

/** Open the plugin's own settings tab; its rows are then in `Setting.rows`. */
export function renderTab(device: Device): SyncryptSettingTab {
  Setting.rows = [];
  const tab = (device.plugin as any).settingTab as SyncryptSettingTab;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the tab's own render entry point
  tab.display();
  return tab;
}

/** The row of that name in the most recent render of the tab. */
export function row(name: string): Setting {
  const r = [...Setting.rows].reverse().find((x) => x.name === name);
  if (r === undefined) {
    throw new Error(`no setting row "${name}" in ${Setting.rows.map((x) => x.name).join(" | ")}`);
  }
  return r;
}

/** The text field of the named row, in the most recent render. */
export function field(name: string): TextComponent {
  const t = row(name).texts[0];
  if (t === undefined) throw new Error(`row "${name}" has no text field`);
  return t;
}

/** The engine an unlock opened. Throws when locked. */
export function engineOf(d: Device): SyncEngine {
  const e = (d.plugin as any).engine as SyncEngine | null;
  if (e === null) throw new Error("device is locked");
  return e;
}

/** What `saveSettings` last persisted (data.json). */
export function saved(d: Device): SyncryptSettings {
  return (d.plugin as any).data as SyncryptSettings;
}

/** "Add this device from a ticket", as the dialog's Connect button runs it. */
export async function importTicket(d: Device, ticket: string, passphrase = PASS): Promise<void> {
  const modal = new AddDeviceModal(d.app, d.plugin);
  (modal as any).ticket = ticket;
  (modal as any).passphrase = passphrase;
  await (modal as any).connect();
}
