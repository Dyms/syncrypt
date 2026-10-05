// ADR-0068: "no shared profile on disk" means "the vault has none" only after
// a pull that ran to the end with config sync on. Audit №4 (C8): the profile
// was published from `finally` after a FAILED first sync; the next sync made
// that a conflict, kept this device's defaults at the path and pushed them
// over the vault's, and every other device adopted them.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SyncError } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../src/i18n.js";
import { resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
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

const PROFILE = ".obsidian/syncrypt-config-sync.json";

/** Reachable for the key parameters; everything else times out while `down`. */
class Flaky extends MemoryStorage {
  down = false;
  override async get(key: string): Promise<Uint8Array> {
    if (this.down && !key.includes("keyfile")) throw new SyncError("StorageTransient", "offline");
    return super.get(key);
  }
  override list(...args: Parameters<MemoryStorage["list"]>): ReturnType<MemoryStorage["list"]> {
    if (this.down) {
      return (async function* () {
        await Promise.resolve();
        throw new SyncError("StorageTransient", "offline");
        yield* [];
      })();
    }
    return super.list(...args);
  }
}

const SHARED = { enabled: true, app: true, plugins: ["dataview", "templater-obsidian"] };
const DEFAULTS = { enabled: true };

/** A vault whose devices already share a profile: A published it. */
async function vaultWithProfile(world: World) {
  const a = await makeDevice(world, {
    ...S3_DATA,
    deviceId: "dev-a",
    autoSync: { enabled: false },
    configSync: SHARED,
  });
  a.adapter.setFile("note.md", "n");
  await unlock(a.plugin, PASS, true);
  await settle(a.plugin); // first sync: none in the vault -> A writes its own
  await a.plugin.syncNow("manual"); // ...and it travels
  expect(a.adapter.getText(PROFILE)).not.toBeNull();
  return a;
}

const flaky = (world: World): Flaky => world.store("s3:https://s3.example.com/notes") as Flaky;

describe("a profile is published only after a completed pull (ADR-0068)", () => {
  it("a device whose first sync failed adopts the vault's profile instead of replacing it", async () => {
    const world = new World(() => new Flaky());
    const a = await vaultWithProfile(world);
    const before = a.adapter.getText(PROFILE);

    const b = await makeDevice(world, {
      ...S3_DATA,
      deviceId: "dev-b",
      autoSync: { enabled: false },
      configSync: DEFAULTS,
    });
    flaky(world).down = true;
    await unlock(b.plugin); // a transient failure does not block the unlock
    await settle(b.plugin); // the startup sync fails
    expect(b.adapter.getText(PROFILE)).toBeNull(); // nothing published on a guess
    flaky(world).down = false;
    await b.plugin.syncNow("manual");
    await b.plugin.syncNow("manual");

    expect(b.plugin.settings.configSync.plugins).toEqual(SHARED.plugins);
    await a.plugin.syncNow("manual");
    expect(a.adapter.getText(PROFILE)).toBe(before);
    expect(a.plugin.settings.configSync.plugins).toEqual(SHARED.plugins);
  });

  it("a settings toggle before the first completed pull does not publish", async () => {
    const world = new World(() => new Flaky());
    await vaultWithProfile(world);
    const b = await makeDevice(world, {
      ...S3_DATA,
      deviceId: "dev-b",
      autoSync: { enabled: false },
      configSync: DEFAULTS,
    });
    flaky(world).down = true;
    await unlock(b.plugin);
    await settle(b.plugin);
    await b.plugin.publishSharedConfig(); // what a category toggle calls
    expect(b.adapter.getText(PROFILE)).toBeNull();
    expect(b.plugin.log.all().map((l) => l.text)).toContain(EN_STRINGS.log.configSyncDeferred);
  });

  it("a pull that ran with config sync OFF does not count", async () => {
    const world = new World(() => new Flaky());
    await vaultWithProfile(world);
    const b = await makeDevice(world, {
      ...S3_DATA,
      deviceId: "dev-b",
      autoSync: { enabled: false },
      configSync: { enabled: false },
    });
    await unlock(b.plugin);
    await settle(b.plugin); // completed — but .obsidian was not syncable
    b.plugin.settings.configSync.enabled = true; // the toggle
    await b.plugin.publishSharedConfig();
    expect(b.adapter.getText(PROFILE)).toBeNull();
  });

  it("after a lock, the next session has to pull again first", async () => {
    const world = new World(() => new Flaky());
    const a = await vaultWithProfile(world);
    await a.adapter.remove(PROFILE); // gone locally; the vault still has it
    a.plugin.lock();
    flaky(world).down = true;
    await unlock(a.plugin);
    await settle(a.plugin);
    await a.plugin.publishSharedConfig();
    expect(a.adapter.getText(PROFILE)).toBeNull();
  });

  it("a sync that returned without finishing its pull does not count", async () => {
    const world = new World(() => new Flaky());
    await vaultWithProfile(world);
    const b = await makeDevice(world, {
      ...S3_DATA,
      deviceId: "dev-b",
      autoSync: { enabled: false },
      configSync: DEFAULTS,
    });
    flaky(world).down = true;
    await unlock(b.plugin);
    await settle(b.plugin);
    flaky(world).down = false;
    const engine = engineOf(b);
    for (const outcome of ["rolled-back", "pull-first", "aborted", "needs-confirmation"] as const) {
      const real = await engine.status();
      const report = real.lastReport ?? { outcome, entries: [] };
      vi.spyOn(engine, "sync").mockResolvedValueOnce({ ...report, outcome } as never);
      if (outcome === "needs-confirmation") {
        vi.spyOn(engine, "dryRun").mockResolvedValueOnce({ ops: [] } as never);
        vi.spyOn(b.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask")
          .mockResolvedValueOnce(false); // declined
      }
      await b.plugin.syncNow("manual");
      expect(b.adapter.getText(PROFILE), outcome).toBeNull();
    }
  });

  it("turning config sync off and on again needs a new pull", async () => {
    const world = new World(() => new Flaky());
    const a = await vaultWithProfile(world);
    a.plugin.settings.configSync.enabled = false;
    await a.plugin.syncNow("manual"); // ran with config sync off
    await a.adapter.remove(PROFILE); // the local copy goes; the vault keeps its own
    a.plugin.settings.configSync.enabled = true;
    await a.plugin.publishSharedConfig();
    expect(a.adapter.getText(PROFILE)).toBeNull();
  });

  async function freshVaultConfigOff() {
    const world = new World(() => new Flaky());
    const b = await makeDevice(world, {
      ...S3_DATA,
      autoSync: { enabled: false },
      configSync: { ...SHARED, enabled: false },
    });
    b.adapter.setFile("note.md", "n");
    await unlock(b.plugin, PASS, true);
    await settle(b.plugin);
    return b;
  }

  it("a pull that ended in conflicts still ran to the end, and counts", async () => {
    const b = await freshVaultConfigOff();
    b.plugin.settings.configSync.enabled = true;
    const engine = engineOf(b);
    const real = await engine.sync(); // with config sync on, nothing new
    vi.spyOn(engine, "sync").mockResolvedValueOnce({ ...real, outcome: "conflicts" });
    await b.plugin.syncNow("manual");
    expect(b.adapter.getText(PROFILE)).not.toBeNull();
  });

  it("switching config sync on while a sync runs does not make that sync count", async () => {
    const b = await freshVaultConfigOff();
    const engine = engineOf(b);
    const sync = engine.sync.bind(engine);
    vi.spyOn(engine, "sync").mockImplementationOnce(async (signal) => {
      const report = await sync(signal); // scanned with .obsidian not syncable
      b.plugin.settings.configSync.enabled = true; // the toggle, mid-sync
      return report;
    });
    await b.plugin.syncNow("manual");
    expect(b.adapter.getText(PROFILE)).toBeNull();
  });

  it("when the vault really has none, a completed pull publishes this device's", async () => {
    const world = new World(() => new Flaky());
    const b = await makeDevice(world, {
      ...S3_DATA,
      autoSync: { enabled: false },
      configSync: SHARED,
    });
    b.adapter.setFile("note.md", "n");
    await unlock(b.plugin, PASS, true);
    await settle(b.plugin);
    expect(b.adapter.getText(PROFILE)).not.toBeNull();
    expect(engineOf(b)).toBeDefined();
  });
});
