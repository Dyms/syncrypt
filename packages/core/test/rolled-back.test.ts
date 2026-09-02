// ADR-0038. The storage that went backwards.
//
// Generations only ever increase (ADR-0006), so nothing in the protocol
// produces a highest-generation LOWER than one this device already synced
// against. Deleting the newest manifest does: the previous generation becomes
// authoritative, every file it describes classifies as "remote is newer", and
// the vault is restored to an earlier state. Everything decrypts perfectly —
// it is not tampering, so nothing fails closed on its own. Write access to the
// bucket is the whole cost of the attack.

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

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
}

const clock = new FixedClock();

function device(storage: MemoryStorage, id: string, state = new MemoryStateStore()): Device {
  const vault = new MemoryVault();
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state,
      deviceId: id,
      storagePrefix: "",
    }),
    vault,
    log,
  };
}

/** Newest manifest first. */
function manifests(storage: MemoryStorage): string[] {
  return storage.keys().filter((k) => k.startsWith("manifests/")).sort().reverse();
}

/**
 * A vault at generation 2: "note.md" was published, then edited and published
 * again. Deleting the newest manifest makes generation 1 authoritative, and
 * generation 1 still says "first version".
 */
async function rolledBackVault(): Promise<{
  storage: MemoryStorage;
  d: Device;
  /** The manifest that was removed, so a test can put it back. */
  removed: { key: string; data: Uint8Array };
}> {
  const storage = new MemoryStorage();
  const d = device(storage, "dev-a");
  // The two versions differ in LENGTH on purpose: the hash cache is keyed by
  // (size, mtime) and the clock does not move in these tests (ADR-0023).
  d.vault.setFile("note.md", "first version");
  await d.engine.sync();
  d.vault.setFile("note.md", "the version the user actually wants");
  await d.engine.sync();
  expect((await d.engine.status()).baseGeneration).toBe(2);

  const newest = manifests(storage)[0] ?? "";
  expect(newest).not.toBe("");
  const data = await storage.get(newest);
  await storage.delete(newest);
  return { storage, d, removed: { key: newest, data } };
}

describe("a storage holding an older generation than this device", () => {
  it("is REFUSED — the newer local file is not rolled back", async () => {
    const { d } = await rolledBackVault();

    const report = await d.engine.pull();

    expect(report.outcome).toBe("rolled-back");
    expect(report.entries).toEqual([]);
    expect(d.vault.getText("note.md")).toBe("the version the user actually wants");
    // Not trashed either: a rollback that lands in the trash is still a
    // rollback, and the user would have to notice to undo it.
    expect(d.vault.trashed).toEqual([]);
  }, 30_000);

  it("refuses on push too, so nothing is republished on top of the old state", async () => {
    const { storage, d } = await rolledBackVault();
    const before = manifests(storage);
    d.vault.setFile("another.md", "written after the rollback");

    const report = await d.engine.push();

    expect(report.outcome).toBe("rolled-back");
    expect(manifests(storage)).toEqual(before);
  }, 30_000);

  it("refuses a confirmed plan too — consent was to the plan, not to this", async () => {
    const { d } = await rolledBackVault();
    const plan = await d.engine.dryRun();

    const report = await d.engine.confirmAndApply(plan);

    expect(report.outcome).toBe("rolled-back");
    expect(d.vault.getText("note.md")).toBe("the version the user actually wants");
  }, 30_000);

  it("says which generations disagree, rather than failing quietly", async () => {
    const { d } = await rolledBackVault();
    await d.engine.pull();
    const notices = d.log.notices.filter((n) => n.code === "storage-rolled-back");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: "storage-rolled-back", remote: 1, base: 2 });
  }, 30_000);

  it("wiping the bucket entirely is the same refusal, not a fresh start", async () => {
    // Generation 0 is "no manifest at all", which on a fresh device means
    // "publish everything". On a device that already synced it means the
    // vault was deleted — and a push here would republish an empty history.
    const storage = new MemoryStorage();
    const d = device(storage, "dev-a");
    d.vault.setFile("note.md", "one");
    await d.engine.sync();
    for (const key of storage.keys()) await storage.delete(key);

    const report = await d.engine.sync();
    expect(report.outcome).toBe("rolled-back");
    expect(storage.keys()).toEqual([]);
  }, 30_000);
});

describe("the refusal does not fire when it should not", () => {
  it("stays quiet for ordinary syncing, including a device that is behind", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a");
    const b = device(storage, "dev-b");
    a.vault.setFile("note.md", "one");
    await a.engine.sync();
    await b.engine.sync();
    // A different LENGTH, not just different content: the hash cache is keyed
    // by (size, mtime) and the clock does not move in these tests (ADR-0023).
    a.vault.setFile("note.md", "one, edited");
    await a.engine.sync();
    await b.engine.sync(); // b is a generation behind: normal, not a rollback

    expect(b.vault.getText("note.md")).toBe("one, edited");
    for (const d of [a, b]) {
      expect(d.log.notices.some((n) => n.code === "storage-rolled-back")).toBe(false);
    }
  }, 30_000);

  it("a device with no base yet is never blocked", async () => {
    // The refusal compares against what this device already synced. A fresh
    // install has nothing to compare, so it must adopt whatever is published —
    // otherwise adding a device to a restored vault would be impossible.
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a");
    a.vault.setFile("note.md", "one");
    await a.engine.sync();
    const fresh = device(storage, "dev-c");

    const report = await fresh.engine.sync();
    expect(report.outcome).not.toBe("rolled-back");
    expect(fresh.vault.getText("note.md")).toBe("one");
  }, 30_000);

  it("recovers by itself when a LIST briefly missed the newest manifest", async () => {
    // Eventually-consistent listings are a fact of object storage. Refusing
    // per sync rather than latching is what makes this self-healing.
    const { storage, d, removed } = await rolledBackVault();
    expect((await d.engine.pull()).outcome).toBe("rolled-back");

    // The listing catches up.
    await storage.put(removed.key, removed.data);
    const report = await d.engine.sync();
    expect(report.outcome).not.toBe("rolled-back");
    expect((await d.engine.status()).baseGeneration).toBe(2);
  }, 30_000);
});

describe("forgetBase is the way out", () => {
  it("unblocks a deliberately restored storage WITHOUT losing the newer file", async () => {
    const { d } = await rolledBackVault();
    expect((await d.engine.pull()).outcome).toBe("rolled-back");

    await d.engine.forgetBase();
    const report = await d.engine.sync();

    expect(report.outcome).not.toBe("rolled-back");
    // The local edit stays where it is; the restored version lands beside it.
    expect(d.vault.getText("note.md")).toBe("the version the user actually wants");
    const copies = d.vault.paths().filter((p) => p.includes("conflicted copy"));
    expect(copies).toHaveLength(1);
    expect(d.vault.getText(copies[0] ?? "")).toBe("first version");
    expect(d.vault.trashed).toEqual([]);
  }, 30_000);

  it("deletes nothing: files the restored manifest never knew about survive", async () => {
    const { d } = await rolledBackVault();
    d.vault.setFile("added-later.md", "written after the last publish");
    await d.engine.forgetBase();

    await d.engine.sync();

    expect(d.vault.getText("added-later.md")).toBe("written after the last publish");
    expect(d.vault.trashed).toEqual([]);
  }, 30_000);

  it("survives a restart — the forgotten base is not remembered again", async () => {
    const storage = new MemoryStorage();
    const state = new MemoryStateStore();
    const d = device(storage, "dev-a", state);
    d.vault.setFile("note.md", "one");
    await d.engine.sync();
    await d.engine.forgetBase();

    const restarted = device(storage, "dev-a", state);
    expect((await restarted.engine.status()).baseGeneration).toBeNull();
  }, 30_000);
});
