// Post-fix review (audit 4 fixes), slice A: core engine. Each test asserts the
// CORRECT behaviour and is expected to be RED on the code under review.

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

class InterleavingStorage extends MemoryStorage {
  hold: ((key: string) => Promise<void>) | null = null;
  override async put(key: string, data: Uint8Array, opts?: Parameters<MemoryStorage["put"]>[2]) {
    if (this.hold !== null && key.startsWith("manifests/")) await this.hold(key);
    return super.put(key, data, opts);
  }
}

/** A vault where chosen paths are there but cannot be read (ADR-0062). */
class FlakyVault extends MemoryVault {
  readonly locked = new Set<VaultPath>();
  override read(path: VaultPath): Promise<Uint8Array> {
    if (this.locked.has(path)) {
      return Promise.reject(new SyncError("VaultWriteFailed", `locked: ${path}`));
    }
    return super.read(path);
  }
}

interface Device {
  engine: SyncEngine;
  vault: FlakyVault;
  log: MemoryLog;
}

const clock = new FixedClock();

function device(storage: MemoryStorage, id: string): Device {
  const vault = new FlakyVault();
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state: new MemoryStateStore(),
      deviceId: id,
      storagePrefix: "",
    }),
    vault,
    log,
  };
}

async function forkOnePath(storage: InterleavingStorage): Promise<{ winner: Device; loser: Device }> {
  const winner = device(storage, "dev-a-winner");
  const loser = device(storage, "dev-b-loser");
  winner.vault.setFile("note.md", "shared starting point");
  await winner.engine.sync();
  await loser.engine.sync();

  winner.vault.setFile("note.md", "the winner's much longer edit");
  loser.vault.setFile("note.md", "the loser's edit");

  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  storage.hold = async (key) => {
    if (key.includes("dev-a-winner")) await gate;
  };
  const winnerPush = winner.engine.push();
  await new Promise((r) => setTimeout(r, 20));
  storage.hold = null;
  const loserReport = await loser.engine.push();
  release();
  const winnerReport = await winnerPush;
  expect(loserReport.outcome).toBe("applied");
  expect(winnerReport.outcome).toBe("applied");
  return { winner, loser };
}

describe("P1: a held path keeps a base entry from a fork this device LOST (ADR-0062 x ADR-0040)", () => {
  it("the loser's edit is not overwritten once the held path becomes readable again", async () => {
    const storage = new InterleavingStorage();
    const { loser } = await forkOnePath(storage);

    // The first pull after the lost fork runs while note.md is locked
    // (OneDrive placeholder, Excel lock...). baseFor() says fork-lost, but the
    // held path keeps this device's LOST base entry under the winner's
    // generation.
    // (A sync client touching the file bumps its mtime; same bytes.)
    loser.vault.now += 5;
    loser.vault.setFile("note.md", "the loser's edit");
    loser.vault.locked.add("note.md");
    await loser.engine.sync();
    expect(loser.log.notices.some((n) => n.code === "fork-lost")).toBe(true);

    // The lock goes away. Nothing on this device changed.
    loser.vault.locked.delete("note.md");
    await loser.engine.sync();

    // Correct: both versions kept (ADR-0040). On the code under review the
    // winner's version is downloaded OVER the loser's edit in place.
    expect(loser.vault.getText("note.md")).toBe("the loser's edit");
    const copies = loser.vault.paths().filter((p) => p.includes("conflicted copy"));
    expect(copies.map((p) => loser.vault.getText(p))).toEqual(["the winner's much longer edit"]);
  }, 30_000);
});

describe("P-lock: an unreadable file the hash cache vouches for still stops the whole push (ADR-0062)", () => {
  it("a workbook opened (locked) after the scan cached it sits the run out instead of failing the sync", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a");
    a.vault.setFile("other.md", "ordinary note");
    a.vault.setFile("book.xlsx", "budget v2");
    // Any scan caches the hash: a status refresh, a dry run, a sync that
    // stopped at pull-first...
    await a.engine.status();
    // Excel opens the workbook: exclusive lock, mtime unchanged.
    a.vault.locked.add("book.xlsx");

    const report = await a.engine.sync();
    // Correct (ADR-0062): book.xlsx is held, other.md goes up.
    expect(report.outcome).toBe("applied");
    expect(report.entries.map((e) => e.path)).toEqual(["other.md"]);
  });
});

/** read() fails for a path the next `n` times it is asked, then works. */
class BrieflyLockedVault extends MemoryVault {
  readonly failures = new Map<VaultPath, number>();
  override read(path: VaultPath): Promise<Uint8Array> {
    const n = this.failures.get(path) ?? 0;
    if (n > 0) {
      this.failures.set(path, n - 1);
      return Promise.reject(new SyncError("VaultWriteFailed", `locked: ${path}`));
    }
    return super.read(path);
  }
}

describe("P2: a path held by the PULL is not held by the PUSH of the same sync (ADR-0062)", () => {
  it("another device's edit is not reverted when the lock lifts between pull and push", async () => {
    const storage = new MemoryStorage();
    const mk = (id: string, vault: MemoryVault) =>
      createSyncEngine({
        storage,
        vault,
        crypto: new IdentityCrypto(),
        clock,
        log: new MemoryLog(),
        state: new MemoryStateStore(),
        deviceId: id,
        storagePrefix: "",
      });
    const firstVault = new MemoryVault();
    const first = mk("first", firstVault);
    const secondVault = new BrieflyLockedVault();
    const second = mk("second", secondVault);

    firstVault.setFile("note.md", "v1");
    await first.sync();
    await second.sync();
    expect(secondVault.getText("note.md")).toBe("v1");

    // There: an edit. Here: the file is touched (same bytes, new mtime) and is
    // locked for one read -- the pull's scan. By the push's scan it is free.
    firstVault.now += 10;
    firstVault.setFile("note.md", "v2 from the first device");
    await first.sync();
    secondVault.now += 10;
    secondVault.setFile("note.md", "v1");
    secondVault.setFile("new.md", "something to push");
    secondVault.failures.set("note.md", 1);
    await second.sync();

    // Nothing touched note.md here; next sync takes v2 down.
    await second.sync();
    await first.sync();
    expect(secondVault.getText("note.md")).toBe("v2 from the first device");
    expect(firstVault.getText("note.md")).toBe("v2 from the first device");
  });
});

/** Runs `during` while one object download is in flight. */
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

describe("P3: the ADR-0064 re-check runs BEFORE the download, not before the write", () => {
  it("an edit saved while that same file is being downloaded is not overwritten", async () => {
    const storage = new SlowObjectStorage();
    const mk = (id: string, vault: MemoryVault) =>
      createSyncEngine({
        storage,
        vault,
        crypto: new IdentityCrypto(),
        clock,
        log: new MemoryLog(),
        state: new MemoryStateStore(),
        deviceId: id,
        storagePrefix: "",
      });
    const oneVault = new MemoryVault();
    const one = mk("one", oneVault);
    oneVault.setFile("big.pdf", "v1");
    await one.sync();
    const twoVault = new MemoryVault();
    const two = mk("two", twoVault);
    await two.sync();

    oneVault.now += 10;
    oneVault.setFile("big.pdf", "v2 from one");
    await one.sync();

    // The 40 MB download takes a minute on the phone; the user annotates the
    // file meanwhile and saves.
    storage.during = () => {
      twoVault.now += 5;
      twoVault.setFile("big.pdf", "annotated on two while it downloaded");
    };
    await two.sync();

    const all: string[] = [];
    for (const p of twoVault.paths()) all.push(twoVault.getText(p) ?? "");
    for (const t of twoVault.trashed) all.push(new TextDecoder().decode(t.data));
    expect(all).toContain("annotated on two while it downloaded");
  });
});
