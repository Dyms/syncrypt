// ADR-0059. Every engine operation takes an AbortSignal, and what cancelling
// MEANS differs by return type: a report says `outcome: "aborted"`, a result
// says nothing happened, and a PLAN cannot say anything at all.
//
// That last case is the dangerous one, and it is where the check was missing.
// A scan cut short has not seen the files it did not reach, and the planner
// reads a path it cannot see as a path that was deleted. Cancelling after
// three of eight files produced a plan with five delete-remote operations and
// requiresConfirmation — the most frightening screen the product has, shown to
// someone who pressed cancel.
//
// Reclamation's preview has the same hole pointing the other way: an object is
// unreachable only relative to the manifests that were READ.

import { describe, expect, it } from "vitest";

import {
  createSyncEngine,
  isSyncError,
  OBJECTS_PREFIX,
  type ObjectStat,
  type SyncEngine,
  type VaultPath,
} from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const DAY = 24 * 60 * 60;

/**
 * A vault that fires the signal part-way through a listing — but only once a
 * test arms it, so the first sync (which establishes the base the planner
 * compares against) completes normally.
 */
class CancellingVault extends MemoryVault {
  armed = false;
  constructor(
    private readonly controller: AbortController,
    private readonly afterFiles: number,
  ) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    let listed = 0;
    for await (const path of super.list()) {
      if (this.armed && listed === this.afterFiles) this.controller.abort();
      listed++;
      yield path;
    }
  }
}

function device(
  storage: MemoryStorage,
  vault: MemoryVault,
  clock = new FixedClock(1_000_000),
): { engine: SyncEngine; log: MemoryLog; clock: FixedClock } {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state: new MemoryStateStore(),
      deviceId: "dev-a",
      storagePrefix: "",
      safeSync: { reclaimGraceSeconds: DAY },
    }),
    log,
    clock,
  };
}

/** A storage that fires the signal part-way through a listing. */
class CancellingStorage extends MemoryStorage {
  armed = false;
  constructor(
    private readonly controller: AbortController,
    private readonly afterKeys: number,
  ) {
    super();
  }
  override async *list(prefix: string): AsyncIterable<ObjectStat> {
    let seen = 0;
    for await (const stat of super.list(prefix)) {
      if (this.armed && seen === this.afterKeys) this.controller.abort();
      seen++;
      yield stat;
    }
  }
}

const EIGHT = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * One device, eight files, already synced — so the engine HAS a base, which is
 * what makes a path it cannot see read as a deletion rather than as a file it
 * has never met. The defect needs that base to show its real shape.
 */
async function syncedDevice(
  vault: MemoryVault = new MemoryVault(),
  storage: MemoryStorage = new MemoryStorage(),
): Promise<{
  storage: MemoryStorage;
  vault: MemoryVault;
  engine: SyncEngine;
  log: MemoryLog;
}> {
  for (const n of EIGHT) vault.setFile(`${n}.md`, `content of ${n}`);
  const d = device(storage, vault);
  const report = await d.engine.sync();
  expect(report.entries).toHaveLength(8);
  return { storage, vault, engine: d.engine, log: d.log };
}

describe("a cancelled dry run is not a plan", () => {
  it("THROWS INSTEAD OF REPORTING THE UNSCANNED FILES AS DELETIONS", async () => {
    // The audit's own reproduction: eight files, cancel after three.
    const controller = new AbortController();
    const vault = new CancellingVault(controller, 3);
    const d = await syncedDevice(vault);
    vault.armed = true;
    vault.now += 10;

    await expect(d.engine.dryRun(controller.signal)).rejects.toSatisfy((e) =>
      isSyncError(e, "Aborted"),
    );
  });

  it("a signal already fired before the scan starts throws too", async () => {
    const d = await syncedDevice();
    const controller = new AbortController();
    controller.abort();

    await expect(d.engine.dryRun(controller.signal)).rejects.toSatisfy((e) =>
      isSyncError(e, "Aborted"),
    );
  });

  it("AND A RUN THAT WAS NOT CANCELLED STILL PLANS NOTHING DESTRUCTIVE", async () => {
    // The other half: the guard must not swallow the real answer.
    const d = await syncedDevice();

    const plan = await d.engine.dryRun(new AbortController().signal);
    expect(plan.operations).toEqual([]);
    expect(plan.requiresConfirmation).toBe(false);
  });

  it("a real deletion is still a real deletion", async () => {
    // And the guard must not hide one: a file actually gone is planned as
    // delete-remote, cancel or no cancel.
    const d = await syncedDevice();
    await d.vault.delete("h.md");

    const plan = await d.engine.dryRun();
    expect(plan.operations.map((o) => `${o.kind} ${o.path}`)).toEqual([
      "delete-remote h.md",
    ]);
  });
});

describe("the journal is not the caller's to edit", () => {
  it("EMPTYING THE RETURNED REPORT DOES NOT REWRITE THE LAST SYNC", async () => {
    // ADR-0060. `status().lastReport` was the same object the caller got, so
    // a client sorting `entries` in place — or clearing them after rendering
    // them — rewrote the record of what the last sync did.
    const d = await syncedDevice();

    // A sync that actually DID something. Clearing an empty array proves
    // nothing, and the second sync here used to be a no-op (ADR-0061).
    d.vault.now += 10;
    d.vault.setFile("i.md", "one more file");
    const fresh = await d.engine.sync();
    expect(fresh.entries).toHaveLength(1);

    fresh.entries.length = 0;
    fresh.conflicts.push("not a conflict");

    const after = await d.engine.status();
    expect(after.lastReport?.entries).toHaveLength(1);
    expect(after.lastReport?.conflicts).toEqual([]);
  });

  it("AND THE SAME HOLDS FOR pull AND push, WHICH TAKE THE OTHER PATH", async () => {
    // `sync()` merges two reports and had its own assignment; pull and push
    // report through `report()`. Both were handing out the journal.
    const d = await syncedDevice();
    await d.vault.write("new.md", new TextEncoder().encode("added since"));
    d.vault.now += 10;

    const pushed = await d.engine.push();
    expect(pushed.entries).toHaveLength(1);
    pushed.entries.length = 0;
    pushed.conflicts.push("not a conflict");

    const after = await d.engine.status();
    expect(after.lastReport?.entries).toHaveLength(1);
    expect(after.lastReport?.conflicts).toEqual([]);
  });

  it("the arrays are copied and the entries inside are SHARED, not cloned", async () => {
    // SyncReport says so: the array belongs to the caller, the entries are
    // read-only. Comparing paths would pass against a deep clone on every
    // sync of a large vault, so this compares identity (ADR-0061).
    const d = await syncedDevice();
    d.vault.now += 10;
    d.vault.setFile("i.md", "one more file");
    const fresh = await d.engine.sync();
    const journal = (await d.engine.status()).lastReport;

    expect(journal?.entries).not.toBe(fresh.entries); // a different array…
    expect(journal?.entries[0]).toBe(fresh.entries[0]); // …of the same entries
  });
});

describe("a cancelled reclamation preview is not a plan either", () => {
  it("THROWS WHEN THE LISTING ITSELF WAS CUT SHORT", async () => {
    // The dangerous shape, and the one this test used to skip by aborting
    // before the call: `readManifestIndex` and `listObjects` return what they
    // REACHED, so a plan built from a partial listing treats every object the
    // unread manifests point at as unreachable (ADR-0061).
    const controller = new AbortController();
    const storage = new CancellingStorage(controller, 2);
    const d = await syncedDevice(new MemoryVault(), storage);
    expect(storage.keys().filter((k) => k.startsWith(OBJECTS_PREFIX))).toHaveLength(8);
    storage.armed = true;

    await expect(d.engine.previewReclaim(controller.signal)).rejects.toSatisfy((e) =>
      isSyncError(e, "Aborted"),
    );
  });

  it("and when the signal fired before it started", async () => {
    const d = await syncedDevice();
    const controller = new AbortController();
    controller.abort();
    await expect(d.engine.previewReclaim(controller.signal)).rejects.toSatisfy((e) =>
      isSyncError(e, "Aborted"),
    );
  });

  it("an uncancelled preview reports the truth: nothing to sweep", async () => {
    const d = await syncedDevice();
    const plan = await d.engine.previewReclaim();
    expect(plan.sweep).toEqual([]);
    expect(plan.waiting).toBe(0);
  });
});

describe("a cancelled reclamation claims only what it did", () => {
  it("DELETES NOTHING AND REPORTS NO WAITING COUNT IT DID NOT MEASURE", async () => {
    const d = await syncedDevice();
    const before = d.storage.keys();
    const controller = new AbortController();
    controller.abort();
    const result = await d.engine.reclaimStorage(controller.signal);

    expect(result.deleted).toEqual([]);
    expect(result.prunedManifests).toBe(0);
    // Read off a plan built from a listing that stopped early: not reported.
    expect(result.waiting).toBe(0);
    expect(result.ripeAt).toBeNull();
    expect(d.storage.keys()).toEqual(before);
    // And no summary line claiming a number nobody measured.
    expect(d.log.notices.filter((n) => n.code === "storage-reclaimed")).toEqual([]);
  });

  it("an uncancelled run still reports and logs as before", async () => {
    const d = await syncedDevice();
    const result = await d.engine.reclaimStorage();

    expect(result.deleted).toEqual([]);
    expect(d.log.notices.some((n) => n.code === "storage-reclaimed")).toBe(true);
  });
});
