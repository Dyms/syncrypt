// F2 (new in d0e7fe1, P4): when every upload of a push is unreadable, the push
// still builds and PUBLISHES a new generation identical to the remote one,
// and reports "applied". A workbook left open all day makes every background
// push mint an empty generation; the ten generations kept for point-in-time
// recovery (ADR-0030) fill with copies of one state.
import { describe, expect, it } from "vitest";

import { createSyncEngine, SyncError, type VaultPath } from "../../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../../src/testing/index.js";

class LockedVault extends MemoryVault {
  readonly locked = new Set<VaultPath>();
  override read(path: VaultPath): Promise<Uint8Array> {
    if (this.locked.has(path)) return Promise.reject(new SyncError("VaultWriteFailed", "locked"));
    return super.read(path);
  }
}

describe("F2: a push with nothing readable to upload", () => {
  it("publishes nothing", async () => {
    const storage = new MemoryStorage();
    const vault = new LockedVault();
    const engine = createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "desk",
      storagePrefix: "",
    });
    vault.setFile("book.xlsx", "v1");
    await engine.sync();
    const manifests = () => storage.keys().filter((k) => k.startsWith("manifests/")).length;
    const before = manifests();

    vault.now += 10;
    vault.setFile("book.xlsx", "v2 - longer");
    await engine.status(); // any scan caches the hash
    vault.locked.add("book.xlsx"); // Excel opens it
    for (let i = 0; i < 3; i++) await engine.push(); // background pushes

    expect(manifests()).toBe(before);
  });

  it("publishes nothing through a confirmed plan either", async () => {
    const storage = new MemoryStorage();
    const vault = new LockedVault();
    const engine = createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "desk",
      storagePrefix: "",
    });
    vault.setFile("a.xlsx", "a1");
    vault.setFile("b.xlsx", "b1");
    await engine.sync();
    const manifests = () => storage.keys().filter((k) => k.startsWith("manifests/")).length;
    const before = manifests();
    vault.now += 10;
    vault.setFile("a.xlsx", "a2 - longer");
    vault.setFile("b.xlsx", "b2 - longer");
    await engine.status(); // cached
    vault.locked.add("a.xlsx");
    vault.locked.add("b.xlsx");
    await engine.confirmAndApply(await engine.dryRun()); // the confirmed path (applyFull)
    expect(manifests()).toBe(before);
  });
});

describe("the hash cache after a download (ADR-0082)", () => {
  it("vouches for what the vault vouched for: the next scan does not re-read it", async () => {
    const storage = new MemoryStorage();
    const mk = (id: string, vault: MemoryVault) =>
      createSyncEngine({
        storage,
        vault,
        crypto: new IdentityCrypto(),
        clock: new FixedClock(),
        log: new MemoryLog(),
        state: new MemoryStateStore(),
        deviceId: id,
        storagePrefix: "",
      });
    const oneVault = new MemoryVault();
    const twoVault = new MemoryVault();
    const one = mk("one", oneVault);
    const two = mk("two", twoVault);
    oneVault.setFile("n.md", "v1");
    await one.sync();
    await two.sync();
    twoVault.reads.length = 0;
    await two.sync();
    expect(twoVault.reads).toEqual([]);
  });
});
