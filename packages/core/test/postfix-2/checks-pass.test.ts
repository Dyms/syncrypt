// Refutation checks: behaviours that HOLD on HEAD (these pass).
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
  readonly trashLocked = new Set<VaultPath>();
  override read(path: VaultPath): Promise<Uint8Array> {
    if (this.locked.has(path)) return Promise.reject(new SyncError("VaultWriteFailed", "locked"));
    return super.read(path);
  }
  override async trash(path: VaultPath): Promise<void> {
    if (this.trashLocked.has(path)) throw new SyncError("VaultWriteFailed", "locked");
    return super.trash(path);
  }
}

function dev(storage: MemoryStorage, id: string, vault: MemoryVault) {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
}

describe("refuted candidates", () => {
  it("confirmAndApply on an empty storage with an unreadable upload: base omits it, next sync uploads it", async () => {
    const storage = new MemoryStorage();
    const v = new LockedVault();
    const e = dev(storage, "a", v);
    v.setFile("x.md", "x");
    v.setFile("y.md", "yy");
    await e.status();
    v.locked.add("y.md");
    const plan = await e.dryRun();
    const r = await e.confirmAndApply(plan);
    expect(r.outcome).toBe("applied");
    v.locked.clear();
    const r2 = await e.sync();
    expect(r2.entries.map((x) => x.path)).toEqual(["y.md"]);
    const b = new MemoryVault();
    await dev(storage, "b", b).sync();
    expect(b.getText("y.md")).toBe("yy");
  });

  it("unreadable at push AND edited remotely: no revert, both kept", async () => {
    const storage = new MemoryStorage();
    const av = new MemoryVault();
    const a = dev(storage, "a", av);
    av.setFile("n.md", "v1");
    await a.sync();
    const bv = new LockedVault();
    const b = dev(storage, "b", bv);
    await b.sync();
    // b edits; a edits; b's file locked (cache vouches) for b's push.
    bv.now += 5;
    bv.setFile("n.md", "v2 from b");
    await b.status();
    bv.locked.add("n.md");
    av.now += 5;
    av.setFile("n.md", "v3 from a, longer");
    await a.sync();
    await b.sync(); // pull: conflict copy of a's; push: n.md unreadable
    bv.locked.clear();
    await b.sync();
    await a.sync();
    const all = [...av.paths().map((p) => av.getText(p)), ...bv.paths().map((p) => bv.getText(p))];
    expect(all).toContain("v2 from b");
    expect(all).toContain("v3 from a, longer");
  });

  it("deleted remotely and locally: no resurrection after push adoption", async () => {
    const storage = new MemoryStorage();
    const av = new MemoryVault();
    const a = dev(storage, "a", av);
    av.setFile("d.md", "d");
    av.setFile("k.md", "k");
    await a.sync();
    const bv = new MemoryVault();
    const b = dev(storage, "b", bv);
    await b.sync();
    await av.delete("d.md");
    await a.sync();
    await bv.delete("d.md");
    bv.setFile("k.md", "k edited");
    await b.push(); // pull-first
    await b.sync();
    await a.sync();
    expect(av.getText("d.md")).toBeNull();
    expect(bv.getText("d.md")).toBeNull();
    expect(av.getText("k.md")).toBe("k edited");
    expect((await b.status()).dirtyFiles).toBe(0);
  });
});
