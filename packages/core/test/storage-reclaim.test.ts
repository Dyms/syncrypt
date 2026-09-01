// ADR-0030 / ADR-0031 end to end, against real engines and real storage:
// tombstones expire on push, and reclaiming storage deletes exactly the
// ciphertext nothing points at any more — and nothing else, ever.

import { describe, expect, it } from "vitest";

import { createSyncEngine, OBJECTS_PREFIX, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const DAY = 24 * 60 * 60;

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
  clock: FixedClock;
}

function makeDevice(
  storage: MemoryStorage,
  deviceId: string,
  clock: FixedClock,
  safeSync: Parameters<typeof createSyncEngine>[0]["safeSync"] = {},
  vault = new MemoryVault(),
): Device {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state: new MemoryStateStore(),
      deviceId,
      storagePrefix: "",
      safeSync,
    }),
    vault,
    log,
    clock,
  };
}

const objects = (storage: MemoryStorage) =>
  storage.keys().filter((k) => k.startsWith(OBJECTS_PREFIX));
const manifests = (storage: MemoryStorage) =>
  storage.keys().filter((k) => k.startsWith("manifests/"));

describe("tombstones expire (ADR-0031)", () => {
  it("a young tombstone survives, an old one does not, and history goes with it", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, { tombstoneGraceSeconds: 30 * DAY });

    d.vault.setFile("old.md", "v1");
    d.vault.setFile("recent.md", "v1");
    await d.engine.sync();

    await d.vault.delete("old.md");
    await d.engine.sync();

    clock.advance(31 * DAY);
    await d.vault.delete("recent.md");
    await d.engine.sync();

    // The push that expires "old.md" is the same one that tombstones
    // "recent.md" — a tombstone written by the expiring push is never dropped.
    const expired = d.log.notices.filter((n) => n.code === "tombstones-expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ code: "tombstones-expired", count: 1 });

    const state = await d.engine.verifyAccess();
    expect(state).not.toBeNull();

    // Reading it back through a fresh device is the honest check.
    const observer = makeDevice(storage, "dev-2", clock);
    await observer.engine.pull();
    expect(observer.vault.paths().includes("old.md")).toBe(false);
    expect(observer.vault.paths().includes("recent.md")).toBe(false);
  });

  it("grace 0 means never — the beta.8 behaviour is one setting away", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, { tombstoneGraceSeconds: 0 });
    d.vault.setFile("gone.md", "v1");
    await d.engine.sync();
    await d.vault.delete("gone.md");
    await d.engine.sync();

    clock.advance(365 * DAY);
    d.vault.setFile("other.md", "v1");
    await d.engine.sync();
    expect(d.log.notices.some((n) => n.code === "tombstones-expired")).toBe(false);
  });
});

describe("reclaiming storage (ADR-0030)", () => {
  it("the first run marks and deletes nothing; the second, a day later, sweeps", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, {
      versionsToKeep: 0,
      generationsToKeep: 1,
      reclaimGraceSeconds: DAY,
    });

    d.vault.setFile("note.md", "the first version");
    await d.engine.sync();
    d.vault.setFile("note.md", "a much longer second version");
    await d.engine.sync();
    expect(objects(storage)).toHaveLength(2); // the old ciphertext is still paid for

    const first = await d.engine.reclaimStorage();
    expect(first.deleted).toEqual([]);
    expect(first.waiting).toBe(1);
    expect(first.ripeAt).toBe(clock.current + DAY);
    expect(objects(storage)).toHaveLength(2);

    clock.advance(DAY);
    const second = await d.engine.reclaimStorage();
    expect(second.deleted).toHaveLength(1);
    expect(second.bytesFreed).toBeGreaterThan(0);
    expect(objects(storage)).toHaveLength(1);

    // The file itself is untouched and still readable end to end.
    const reader = makeDevice(storage, "dev-2", clock);
    await reader.engine.pull();
    expect(reader.vault.getText("note.md")).toBe("a much longer second version");
  });

  it("never deletes an object a retained manifest still points at", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, { reclaimGraceSeconds: 0 });
    d.vault.setFile("a.md", "A");
    d.vault.setFile("b.md", "B");
    await d.engine.sync();

    const before = objects(storage);
    const result = await d.engine.reclaimStorage();
    expect(result.deleted).toEqual([]);
    expect(objects(storage)).toEqual(before);
  });

  it("never deletes the keyfile, even when every file in the vault is gone", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, {
      versionsToKeep: 0,
      generationsToKeep: 1,
      reclaimGraceSeconds: 0,
      tombstoneGraceSeconds: 1,
    });
    // The keyfile is written by the SDK, not the engine; put it there by hand.
    await storage.put("meta/keyfile-params.json", new TextEncoder().encode("{}"));

    d.vault.setFile("a.md", "A");
    d.vault.setFile("b.md", "B");
    await d.engine.sync();
    await d.vault.delete("a.md");
    await d.vault.delete("b.md");
    clock.advance(10);
    await d.engine.sync();

    await d.engine.reclaimStorage();
    expect(objects(storage)).toEqual([]); // everything really was collected
    expect(storage.keys()).toContain("meta/keyfile-params.json");
  });

  it("prunes old manifest generations and leaves the newest ones alone", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, {
      generationsToKeep: 2,
      reclaimGraceSeconds: 0,
    });
    for (let i = 0; i < 5; i++) {
      d.vault.setFile(`note-${String(i)}.md`, `v${String(i)}`);
      await d.engine.sync();
    }
    expect(manifests(storage)).toHaveLength(5);

    const result = await d.engine.reclaimStorage();
    expect(result.prunedManifests).toBe(3);
    expect(manifests(storage)).toHaveLength(2);

    // Pruning generations must not break the vault for anyone.
    const reader = makeDevice(storage, "dev-2", clock);
    await reader.engine.pull();
    expect(reader.vault.paths().includes("note-4.md")).toBe(true);
  });

  it("THE RACE: content that comes back is never collected", async () => {
    // The reason "unreferenced and old" is the wrong rule. A note is deleted,
    // its tombstone expires, its ciphertext is marked. Then the user writes
    // the same content again: the dedup probe in applyPushOps finds the object
    // and skips the upload, so the new manifest points straight at the object
    // GC was about to take. Only re-checking reachability at sweep time saves
    // it — object age would not.
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, {
      versionsToKeep: 0,
      generationsToKeep: 1,
      reclaimGraceSeconds: DAY,
      tombstoneGraceSeconds: 1,
    });

    d.vault.setFile("note.md", "irreplaceable");
    await d.engine.sync();
    await d.vault.delete("note.md");
    clock.advance(10);
    await d.engine.sync(); // deletes it and expires the tombstone in one go

    const marked = await d.engine.reclaimStorage();
    expect(marked.deleted).toEqual([]);
    expect(marked.waiting).toBe(1); // ripe in a day

    // A day later — but the user has recreated the note in the meantime.
    clock.advance(DAY);
    d.vault.setFile("note.md", "irreplaceable");
    await d.engine.sync();
    expect(d.vault.reads).toContain("note.md");

    const swept = await d.engine.reclaimStorage();
    expect(swept.deleted).toEqual([]);
    expect(objects(storage)).toHaveLength(1);

    // And the content is genuinely still there for another device.
    const reader = makeDevice(storage, "dev-2", clock);
    await reader.engine.pull();
    expect(reader.vault.getText("note.md")).toBe("irreplaceable");
  });

  it("previewReclaim publishes nothing and marks nothing", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, { versionsToKeep: 0, generationsToKeep: 1 });
    d.vault.setFile("note.md", "one");
    await d.engine.sync();
    d.vault.setFile("note.md", "two but longer");
    await d.engine.sync();

    const before = storage.keys();
    const plan = await d.engine.previewReclaim();
    expect(plan.waiting).toBe(1);
    expect(storage.keys()).toEqual(before);
  });

  it("a deleted file's ciphertext survives until its tombstone expires", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const d = makeDevice(storage, "dev-1", clock, {
      versionsToKeep: 3,
      generationsToKeep: 1,
      reclaimGraceSeconds: 0,
      tombstoneGraceSeconds: 30 * DAY,
    });
    d.vault.setFile("note.md", "content");
    await d.engine.sync();
    await d.vault.delete("note.md");
    await d.engine.sync();

    // history[note.md] still points at it, so it is reachable and stays.
    await d.engine.reclaimStorage();
    expect(objects(storage)).toHaveLength(1);

    // …until the tombstone expires and takes the history with it (ADR-0031).
    clock.advance(31 * DAY);
    d.vault.setFile("other.md", "x");
    await d.engine.sync();
    await d.engine.reclaimStorage();
    expect(objects(storage)).toHaveLength(1); // only other.md's object remains
  });
});
