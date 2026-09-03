// The dedup probe is an optimization: a storage that cannot answer it must not
// fail the sync. Objects are content-addressed, so re-uploading is harmless.

import { describe, expect, it } from "vitest";

import { createSyncEngine, SyncError, type ObjectStat, type StoragePort } from "@syncrypt/core";
import {
  FixedClock,
  IdentityCrypto,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "@syncrypt/core/testing";

/** A storage whose stat() is broken at transport level — Obsidian on Android
 *  before the fallbacks — while everything else works. */
function withBrokenStat(inner: MemoryStorage): StoragePort {
  return {
    capabilities: () => inner.capabilities(),
    get: (key) => inner.get(key),
    put: (key, data, opts) => inner.put(key, data, opts),
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
    stat: (key: string): Promise<ObjectStat> =>
      Promise.reject(new SyncError("StorageTransient", `S3 stat "${key}": network error`)),
  };
}

describe("upload when the existence probe is unavailable", () => {
  it("never overwrites blindly: uses create-if-absent, and an existing object is fine", async () => {
    const storage = new MemoryStorage();
    const attempted: { key: string; ifNoneMatch: string | undefined }[] = [];
    const vault = new MemoryVault();
    vault.setFile("note.md", "hello");

    const recording: StoragePort = {
      capabilities: () => ({ ...storage.capabilities(), conditionalWrites: true }),
      get: (key) => storage.get(key),
      delete: (key) => storage.delete(key),
      list: (prefix) => storage.list(prefix),
      stat: (key: string): Promise<ObjectStat> =>
        Promise.reject(new SyncError("StorageTransient", `S3 stat "${key}": network error`)),
      put: (key, data, opts) => {
        if (key.startsWith("objects/")) {
          attempted.push({ key, ifNoneMatch: opts?.ifNoneMatch });
        }
        return storage.put(key, data, opts);
      },
    };

    const engine = createSyncEngine({
      storage: recording,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      state: new MemoryStateStore(),
      deviceId: "device-a",
      storagePrefix: "",
    });
    const report = await engine.sync();

    expect(report.outcome).toBe("applied");
    expect(attempted).toHaveLength(1);
    // The guard is what makes "no blind overwrite" structural, not rhetorical.
    expect(attempted[0]?.ifNoneMatch).toBe("*");
  });

  it("treats a precondition failure as success — the object was already there", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    vault.setFile("note.md", "hello");
    const rejecting: StoragePort = {
      capabilities: () => ({ ...storage.capabilities(), conditionalWrites: true }),
      get: (key) => storage.get(key),
      delete: (key) => storage.delete(key),
      list: (prefix) => storage.list(prefix),
      stat: (key: string): Promise<ObjectStat> =>
        Promise.reject(new SyncError("StorageTransient", `S3 stat "${key}": network error`)),
      put: (key, data, opts) =>
        key.startsWith("objects/")
          ? Promise.reject(new SyncError("StoragePreconditionFailed", `already there: ${key}`))
          : storage.put(key, data, opts),
    };
    const engine = createSyncEngine({
      storage: rejecting,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      state: new MemoryStateStore(),
      deviceId: "device-a",
      storagePrefix: "",
    });

    const report = await engine.sync();
    expect(report.outcome).toBe("applied");
    expect(report.entries).toHaveLength(1);
  });

  it("uploads anyway and completes the sync", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    vault.setFile("note.md", "hello");
    const engine = createSyncEngine({
      storage: withBrokenStat(storage),
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      state: new MemoryStateStore(),
      deviceId: "device-a",
      storagePrefix: "",
    });

    const report = await engine.sync();
    expect(report.outcome).toBe("applied");
    expect(report.entries).toHaveLength(1);

    // The object really is in storage despite the unusable probe.
    const keys: string[] = [];
    for await (const stat of storage.list("objects/")) keys.push(stat.key);
    expect(keys).toHaveLength(1);
  });
});

describe("an object adopted from the probe is confirmed before the manifest names it", () => {
  /**
   * One engine, one state store, one vault — the sequence that makes a push
   * ADOPT an object instead of uploading it: content that exists in storage
   * from an earlier generation comes back.
   */
  async function adoptingPush(hooks: {
    onDedupProbe?: (key: string, storage: MemoryStorage) => void;
    failConfirmation?: boolean;
  }) {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    let armed = false;
    let objectStats = 0;
    const hooked: StoragePort = {
      capabilities: () => storage.capabilities(),
      get: (key) => storage.get(key),
      put: (key, data, opts) => storage.put(key, data, opts),
      delete: (key) => storage.delete(key),
      list: (prefix) => storage.list(prefix),
      stat: async (key: string): Promise<ObjectStat> => {
        if (!armed || !key.startsWith("objects/")) return storage.stat(key);
        const which = objectStats++;
        if (which === 0) {
          // The dedup probe.
          const stat = await storage.stat(key);
          hooks.onDedupProbe?.(key, storage);
          return stat;
        }
        // The confirmation.
        if (hooks.failConfirmation === true) {
          throw new SyncError("StorageTransient", `S3 stat "${key}": network error`);
        }
        return storage.stat(key);
      },
    };
    const engine = createSyncEngine({
      storage: hooked,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      state: new MemoryStateStore(),
      deviceId: "device-a",
      storagePrefix: "",
    });

    vault.setFile("note.md", "hello");
    await engine.sync();
    vault.now += 10;
    vault.setFile("note.md", "something else entirely");
    await engine.sync();
    vault.now += 10;
    vault.setFile("note.md", "hello"); // back to content that is still stored

    const manifestsBefore: string[] = [];
    for await (const stat of storage.list("manifests/")) manifestsBefore.push(stat.key);
    armed = true;
    return { engine, storage, manifestsBefore };
  }

  it("REFUSES TO PUBLISH A MANIFEST POINTING AT BYTES THAT ARE GONE", async () => {
    const { engine, storage, manifestsBefore } = await adoptingPush({
      // Reclaim on another device sweeps it between the probe and the commit.
      onDedupProbe: (key, s) => void s.delete(key),
    });

    await expect(engine.sync()).rejects.toThrow(/is gone now/);

    const manifestsAfter: string[] = [];
    for await (const stat of storage.list("manifests/")) manifestsAfter.push(stat.key);
    expect(manifestsAfter).toEqual(manifestsBefore); // nothing was published
  });

  it("a probe that cannot answer is not evidence of absence — the push proceeds", async () => {
    const { engine } = await adoptingPush({ failConfirmation: true });
    const report = await engine.sync();
    expect(report.outcome).toBe("applied");
  });
});
