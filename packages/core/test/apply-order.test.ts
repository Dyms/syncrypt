// ADR-0080: what apply checks, it checks after the download and before the
// write; a file it cannot move to the trash sits the run out.

import { describe, expect, it } from "vitest";

import { createSyncEngine, SyncError, type SyncEngine, type VaultPath } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

class SlowObjectStorage extends MemoryStorage {
  during: (() => void) | null = null;
  override async get(key: string): Promise<Uint8Array> {
    const f = this.during;
    if (f !== null && key.startsWith("objects/")) {
      this.during = null;
      f();
    }
    return super.get(key);
  }
}

function device(storage: MemoryStorage, id: string, vault: MemoryVault): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(1_000_000),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
}

describe("checked after the download (P3)", () => {
  it("a file the user CREATES while it downloads is kept, the remote one beside it", async () => {
    const storage = new SlowObjectStorage();
    const oneVault = new MemoryVault();
    const one = device(storage, "one", oneVault);
    oneVault.setFile("new.md", "from one");
    await one.sync();
    const twoVault = new MemoryVault();
    const two = device(storage, "two", twoVault);
    storage.during = () => {
      twoVault.setFile("new.md", "typed on two while it downloaded");
    };
    await two.sync();
    expect(twoVault.getText("new.md")).toBe("typed on two while it downloaded");
    const copies = twoVault.paths().filter((p) => p.includes("conflicted copy"));
    expect(copies.map((p) => twoVault.getText(p))).toEqual(["from one"]);
  });
});

/** trash() fails for paths in `locked` — a file held open elsewhere. */
class LockedTrashVault extends MemoryVault {
  readonly locked = new Set<VaultPath>();
  override async trash(path: VaultPath): Promise<void> {
    if (this.locked.has(path)) throw new SyncError("VaultWriteFailed", `locked: ${path}`);
    return super.trash(path);
  }
}

describe("a file that cannot be moved to the trash (P4)", () => {
  it("sits the run out; everything else syncs; it goes once it can", async () => {
    const storage = new MemoryStorage();
    const oneVault = new MemoryVault();
    const one = device(storage, "one", oneVault);
    oneVault.setFile("gone.md", "deleted on one");
    oneVault.setFile("keep.md", "k");
    await one.sync();
    const twoVault = new LockedTrashVault();
    const two = device(storage, "two", twoVault);
    await two.sync();
    await oneVault.delete("gone.md");
    oneVault.setFile("new.md", "nn");
    await one.sync();

    twoVault.locked.add("gone.md");
    const report = await two.sync();
    expect(report.outcome).toBe("applied");
    expect(twoVault.getText("new.md")).toBe("nn");
    expect(twoVault.getText("gone.md")).toBe("deleted on one"); // still here
    expect((await two.status()).lastReport?.entries.map((e) => e.path)).not.toContain("gone.md");

    twoVault.locked.clear();
    await two.sync();
    expect(twoVault.getText("gone.md")).toBeNull();
    expect(twoVault.trashed.map((t) => t.path)).toContain("gone.md");
    // ...and the deletion was never undone for the other device.
    await one.sync();
    expect(oneVault.getText("gone.md")).toBeNull();
  });
});

describe("a confirmed sync that pulls and pushes (ADR-0080)", () => {
  it("leaves a base that the next sync agrees with: nothing to do", async () => {
    const storage = new MemoryStorage();
    const oneVault = new MemoryVault();
    const one = device(storage, "one", oneVault);
    for (const n of ["a", "b", "c", "d"]) oneVault.setFile(`${n}.md`, n);
    await one.sync();
    const twoVault = new MemoryVault();
    const two = createSyncEngine({
      storage,
      vault: twoVault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(1_000_000),
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "two",
      storagePrefix: "",
      safeSync: { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 },
    });
    await two.sync();
    // Remote: three deletions (needs confirmation) and an edit; local: an edit.
    for (const n of ["a", "b", "c"]) await oneVault.delete(`${n}.md`);
    oneVault.setFile("d.md", "d, edited on one");
    await one.sync();
    twoVault.setFile("mine.md", "written on two");
    expect((await two.sync()).outcome).toBe("needs-confirmation");
    const applied = await two.confirmAndApply(await two.dryRun());
    expect(applied.entries.map((e) => e.path)).toContain("mine.md");
    expect((await two.status()).dirtyFiles).toBe(0);
    const again = await two.sync();
    expect(again.entries).toEqual([]);
  });
});
