// ADR-0071: acceptRolledBack forgets the base only if the storage is behind it
// at that moment — the check and the forget are one queued operation.

import { describe, expect, it } from "vitest";

import { createSyncEngine, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

function open(storage: MemoryStorage, vault: MemoryVault, state: MemoryStateStore): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(1_000_000),
    log: new MemoryLog(),
    state,
    deviceId: "dev-1",
    storagePrefix: "",
  });
}

async function synced(): Promise<{
  storage: MemoryStorage;
  engine: SyncEngine;
  vault: MemoryVault;
  state: MemoryStateStore;
}> {
  const storage = new MemoryStorage();
  const vault = new MemoryVault();
  const state = new MemoryStateStore();
  const engine = open(storage, vault, state);
  vault.setFile("a.md", "a");
  await engine.sync();
  vault.setFile("a.md", "a, longer");
  await engine.sync();
  return { storage, engine, vault, state };
}

const dropNewest = async (s: MemoryStorage): Promise<void> => {
  const top = s
    .keys()
    .filter((k) => k.startsWith("manifests/"))
    .sort()
    .at(-1);
  if (top === undefined) throw new Error("no manifest");
  await s.delete(top);
};

describe("acceptRolledBack (ADR-0071)", () => {
  it("does nothing when the storage is not behind", async () => {
    const { engine } = await synced();
    const before = (await engine.status()).baseGeneration;
    expect(await engine.acceptRolledBack()).toBe(false);
    expect((await engine.status()).baseGeneration).toBe(before);
  });

  it("forgets the base when it is", async () => {
    const { storage, engine } = await synced();
    await dropNewest(storage);
    expect((await engine.sync()).outcome).toBe("rolled-back");
    expect(await engine.acceptRolledBack()).toBe(true);
    expect((await engine.status()).baseGeneration).toBeNull();
    expect((await engine.sync()).outcome).not.toBe("rolled-back");
  });

  it("the forgetting is persisted: a restart does not bring the refusal back", async () => {
    const { storage, engine, vault, state } = await synced();
    await dropNewest(storage);
    expect(await engine.acceptRolledBack()).toBe(true);
    const restarted = open(storage, vault, state);
    expect((await restarted.status()).baseGeneration).toBeNull();
  });

  it("a cancelled check forgets nothing", async () => {
    const { storage, engine } = await synced();
    await dropNewest(storage);
    const ctl = new AbortController();
    ctl.abort();
    await expect(engine.acceptRolledBack(ctl.signal)).rejects.toMatchObject({ code: "Aborted" });
    expect((await engine.status()).baseGeneration).not.toBeNull();
  });
});
