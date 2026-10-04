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

const EIGHT = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * One device, eight files, already synced — so the engine HAS a base, which is
 * what makes a path it cannot see read as a deletion rather than as a file it
 * has never met. The defect needs that base to show its real shape.
 */
async function syncedDevice(vault: MemoryVault = new MemoryVault()): Promise<{
  storage: MemoryStorage;
  vault: MemoryVault;
  engine: SyncEngine;
  log: MemoryLog;
}> {
  const storage = new MemoryStorage();
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
    const report = await d.engine.status().then((s) => s.lastReport);
    expect(report?.entries).toHaveLength(8);

    const fresh = await d.engine.sync();
    fresh.entries.length = 0;
    fresh.conflicts.push("not a conflict");

    const after = await d.engine.status();
    expect(after.lastReport?.outcome).toBe("no-op");
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

  it("and the entries the caller holds are the ones the journal logged", async () => {
    // The arrays are copied; the entries inside are shared and documented
    // read-only. This pins that it IS the same content, so nobody "fixes" the
    // copy into a deep clone on every sync of a large vault by accident.
    const d = await syncedDevice();
    const report = (await d.engine.status()).lastReport;
    expect(report?.entries.map((e) => e.path).sort()).toEqual(
      EIGHT.map((n) => `${n}.md`).sort(),
    );
  });
});

describe("a cancelled reclamation preview is not a plan either", () => {
  it("THROWS INSTEAD OF PROPOSING TO DELETE LIVE OBJECTS", async () => {
    const d = await syncedDevice();
    expect(d.storage.keys().filter((k) => k.startsWith(OBJECTS_PREFIX))).toHaveLength(8);

    // A listing that stopped early: every object the manifests it did not
    // read still point at now looks unreachable.
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
