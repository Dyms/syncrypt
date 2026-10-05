// ADR-0072: SyncEngine.setSafeSync replaces the Safe Sync options of an open
// engine — breaker and retention alike — queued behind a running sync.

import { describe, expect, it } from "vitest";

import { createSyncEngine, parseManifest, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const STRICT = { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 };

function open(storage: MemoryStorage, vault: MemoryVault): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(1_000_000),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: "dev-1",
    storagePrefix: "",
  });
}

async function threeFiles(storage = new MemoryStorage()) {
  const vault = new MemoryVault();
  const engine = open(storage, vault);
  for (const n of ["a", "b", "c"]) vault.setFile(`${n}.md`, n);
  await engine.sync();
  return { storage, vault, engine };
}

async function top(storage: MemoryStorage) {
  const key = storage.keys().filter((k) => k.startsWith("manifests/")).sort().at(-1) ?? "";
  return parseManifest(await new IdentityCrypto().decrypt("manifest", await storage.get(key)));
}

describe("setSafeSync (ADR-0072)", () => {
  it("a tightened breaker fires on the next sync", async () => {
    const { vault, engine } = await threeFiles();
    await engine.setSafeSync(STRICT);
    for (const n of ["a", "b", "c"]) await vault.delete(`${n}.md`);
    expect((await engine.sync()).outcome).toBe("needs-confirmation");
  });

  it("retention changes too", async () => {
    const { storage, vault, engine } = await threeFiles();
    await engine.setSafeSync({ versionsToKeep: 1 });
    for (const v of ["a2", "a33", "a444"]) {
      vault.setFile("a.md", v);
      await engine.sync();
    }
    expect((await top(storage)).history?.["a.md"]).toHaveLength(1);
  });

  it("unspecified fields go back to their defaults, as in the config", async () => {
    const { vault, engine } = await threeFiles();
    await engine.setSafeSync(STRICT);
    await engine.setSafeSync({});
    for (const n of ["a", "b", "c"]) await vault.delete(`${n}.md`);
    expect((await engine.sync()).outcome).toBe("applied");
  });

  it("waits for the step in flight: a plan is made with one set", async () => {
    let release = (): void => undefined;
    class Gate extends MemoryStorage {
      armed = false;
      override async get(key: string): Promise<Uint8Array> {
        if (this.armed && key.startsWith("manifests/")) {
          this.armed = false;
          await new Promise<void>((r) => (release = r));
        }
        return super.get(key);
      }
    }
    const storage = new Gate();
    const { engine } = await threeFiles(storage);
    storage.armed = true;
    const running = engine.pull();
    await new Promise((r) => setTimeout(r, 20)); // inside its manifest read
    let applied = false;
    const tightened = engine.setSafeSync(STRICT).then(() => (applied = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(applied).toBe(false);
    release();
    await running;
    await tightened;
    expect(applied).toBe(true);
  });
});
