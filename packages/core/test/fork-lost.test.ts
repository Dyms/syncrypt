// ADR-0035. The fork the publisher cannot see.
//
// publishManifest re-LISTs after its own write, so it detects a fork that
// already exists at that instant. It cannot detect one created a moment LATER:
// the loser publishes first, sees only itself, reports success, and adopts its
// own manifest as base. From then on the planner trusts a manifest nobody else
// will ever read as the common ancestor — and reads the winner's version of a
// file the loser also changed as "remote is newer", which is a silent
// overwrite of the user's edit.

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

/** Lets one device be frozen between reading the remote state and publishing. */
class InterleavingStorage extends MemoryStorage {
  hold: ((key: string) => Promise<void>) | null = null;
  override async put(key: string, data: Uint8Array, opts?: Parameters<MemoryStorage["put"]>[2]) {
    if (this.hold !== null && key.startsWith("manifests/")) await this.hold(key);
    return super.put(key, data, opts);
  }
}

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
}

const clock = new FixedClock();

function device(storage: MemoryStorage, id: string): Device {
  const vault = new MemoryVault();
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

/**
 * Both devices edit `note.md` offline, then publish generation 2 without
 * seeing each other. "dev-a-winner" wins the fork (smallest deviceId).
 */
async function forkOnePath(storage: InterleavingStorage): Promise<{ winner: Device; loser: Device }> {
  const winner = device(storage, "dev-a-winner");
  const loser = device(storage, "dev-b-loser");
  winner.vault.setFile("note.md", "shared starting point");
  await winner.engine.sync();
  await loser.engine.sync();

  winner.vault.setFile("note.md", "the winner's much longer edit");
  loser.vault.setFile("note.md", "the loser's edit");

  // The WINNER is held before its write, so the LOSER publishes first and its
  // re-LIST sees only itself. That is the case publishManifest cannot catch.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  storage.hold = async (key) => { if (key.includes("dev-a-winner")) await gate; };
  const winnerPush = winner.engine.push();
  await new Promise((r) => setTimeout(r, 20));
  storage.hold = null;
  const loserReport = await loser.engine.push();
  release();
  const winnerReport = await winnerPush;

  // Both believed they committed. That is the premise, not the bug.
  expect(loserReport.outcome).toBe("applied");
  expect(winnerReport.outcome).toBe("applied");
  return { winner, loser };
}

describe("the loser of a fork it never saw", () => {
  it("KEEPS BOTH VERSIONS instead of losing its own", async () => {
    const storage = new InterleavingStorage();
    const { loser } = await forkOnePath(storage);

    const report = await loser.engine.pull();

    // The edit that was silently discarded before this ADR.
    expect(loser.vault.getText("note.md")).toBe("the loser's edit");
    // …and the winner's version is beside it, not instead of it.
    const copies = loser.vault.paths().filter((p) => p.includes("conflicted copy"));
    expect(copies).toHaveLength(1);
    expect(loser.vault.getText(copies[0] ?? "")).toBe("the winner's much longer edit");
    expect(report.conflicts).toEqual(["note.md"]);
    expect(report.outcome).toBe("conflicts");
    // Nothing was trashed to achieve that.
    expect(loser.vault.trashed).toEqual([]);
  }, 30_000);

  it("says so, once, rather than repairing in silence", async () => {
    const storage = new InterleavingStorage();
    const { loser } = await forkOnePath(storage);
    await loser.engine.pull();
    const notices = loser.log.notices.filter((n) => n.code === "fork-lost");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: "fork-lost", generation: 2 });
  }, 30_000);

  it("the WINNER is untouched — no conflict, no notice, no extra work", async () => {
    const storage = new InterleavingStorage();
    const { winner } = await forkOnePath(storage);
    const report = await winner.engine.pull();
    expect(report.conflicts).toEqual([]);
    expect(winner.vault.paths()).toEqual(["note.md"]);
    expect(winner.vault.getText("note.md")).toBe("the winner's much longer edit");
    expect(winner.log.notices.some((n) => n.code === "fork-lost")).toBe(false);
  }, 30_000);

  it("recovers: after the repair both devices agree, and stay agreed", async () => {
    const storage = new InterleavingStorage();
    const { winner, loser } = await forkOnePath(storage);
    await loser.engine.sync(); // conflict materialized, then published
    await winner.engine.sync();
    await loser.engine.sync();

    expect(winner.vault.paths()).toEqual(loser.vault.paths());
    for (const path of winner.vault.paths()) {
      expect(winner.vault.getText(path), path).toBe(loser.vault.getText(path));
    }
    // And the repair does not repeat itself for ever.
    const before = loser.log.notices.filter((n) => n.code === "fork-lost").length;
    await loser.engine.sync();
    expect(loser.log.notices.filter((n) => n.code === "fork-lost")).toHaveLength(before);
  }, 30_000);

  it("does NOT fire on the ordinary case: same generation, same publisher", async () => {
    // Two devices in step, one publisher — the base IS the authoritative
    // manifest. A false positive here would turn every quiet sync into
    // conflicted copies.
    const storage = new InterleavingStorage();
    const a = device(storage, "dev-a");
    const b = device(storage, "dev-b");
    a.vault.setFile("note.md", "one");
    await a.engine.sync();
    await b.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.log.notices.some((n) => n.code === "fork-lost")).toBe(false);
    expect(b.log.notices.some((n) => n.code === "fork-lost")).toBe(false);
    expect(b.vault.paths()).toEqual(["note.md"]);
  }, 30_000);

  it("files that did NOT diverge are left alone, not turned into conflicts", async () => {
    // Planning without a base is only honest if it stays quiet about the
    // thousands of files that are identical on both sides.
    const storage = new InterleavingStorage();
    const winner = device(storage, "dev-a-winner");
    const loser = device(storage, "dev-b-loser");
    for (let i = 0; i < 20; i++) winner.vault.setFile(`note-${String(i)}.md`, `content ${String(i)}`);
    await winner.engine.sync();
    await loser.engine.sync();

    winner.vault.setFile("note-0.md", "changed by the winner, at length");
    loser.vault.setFile("note-0.md", "changed by the loser");

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    storage.hold = async (key) => { if (key.includes("dev-a-winner")) await gate; };
    const winnerPush = winner.engine.push();
    await new Promise((r) => setTimeout(r, 20));
    storage.hold = null;
    await loser.engine.push();
    release();
    await winnerPush;

    const report = await loser.engine.pull();
    expect(report.conflicts).toEqual(["note-0.md"]);
    expect(report.entries.filter((e) => e.kind === "download")).toHaveLength(0);
    expect(loser.vault.getText("note-19.md")).toBe("content 19");
  }, 30_000);
});
