// ADR-0067: what the person was shown is a ceiling on what reclaimStorage
// deletes. The engine still recomputes (ADR-0030: never sweep a stale plan),
// so it can delete LESS than the preview — never more.

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

function device(storage: MemoryStorage, clock: FixedClock): { engine: SyncEngine; vault: MemoryVault } {
  const vault = new MemoryVault();
  const engine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: "dev-1",
    storagePrefix: "",
    safeSync: { versionsToKeep: 0, generationsToKeep: 1, reclaimGraceSeconds: DAY },
  });
  return { engine, vault };
}

const objects = (storage: MemoryStorage): string[] =>
  storage.keys().filter((k) => k.startsWith(OBJECTS_PREFIX));
const manifests = (storage: MemoryStorage): string[] =>
  storage.keys().filter((k) => k.startsWith("manifests/"));

/** v1 marked a day ago (ripe), v2 marked a minute later (not yet). */
async function twoGarbageObjects(): Promise<{
  storage: MemoryStorage;
  clock: FixedClock;
  engine: SyncEngine;
}> {
  const storage = new MemoryStorage();
  const clock = new FixedClock();
  const { engine, vault } = device(storage, clock);
  vault.setFile("note.md", "v1");
  await engine.sync();
  vault.setFile("note.md", "v2, longer");
  await engine.sync();
  await engine.reclaimStorage(); // marks v1
  clock.advance(60);
  vault.setFile("note.md", "v3, longer still");
  await engine.sync();
  await engine.reclaimStorage(); // marks v2
  clock.advance(DAY - 60); // v1 ripe now, v2 a minute away
  return { storage, clock, engine };
}

describe("reclaimStorage with an approval (ADR-0067)", () => {
  it("deletes no more than was shown, however much ripened meanwhile", async () => {
    const { storage, clock, engine } = await twoGarbageObjects();
    const shown = await engine.previewReclaim();
    expect(shown.sweep).toHaveLength(1);
    clock.advance(120); // the dialog is read; v2 ripens behind it
    expect((await engine.previewReclaim()).sweep).toHaveLength(2);

    const before = objects(storage).length;
    const result = await engine.reclaimStorage(undefined, {
      sweep: shown.sweep,
      prunedManifests: shown.prunedManifests,
    });
    expect(result.deleted).toEqual(shown.sweep);
    expect(objects(storage)).toHaveLength(before - 1);
    // The one held back is ripe and still counted, so the next run offers it.
    expect(result.waiting).toBe(1);
    expect(result.ripeAt).toBe(clock.now());
    expect((await engine.previewReclaim()).sweep).toHaveLength(1);
  });

  it("an empty approval deletes nothing and keeps the clocks running", async () => {
    const { storage, clock, engine } = await twoGarbageObjects();
    clock.advance(120); // both ripe
    const before = objects(storage);
    const result = await engine.reclaimStorage(undefined, { sweep: [], prunedManifests: [] });
    expect(result.deleted).toEqual([]);
    expect(result.prunedManifests).toBe(0);
    expect(objects(storage)).toEqual(before);
    // Held, not restarted: both are offered at once on the next look.
    expect((await engine.previewReclaim()).sweep).toHaveLength(2);
  });

  it("a generation published after the preview is not pruned on its account", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const { engine, vault } = device(storage, clock);
    // Different lengths: MemoryVault keeps one mtime, so a same-length edit is
    // invisible to the scan (ADR-0023's hash-cache key).
    vault.setFile("note.md", "v1");
    await engine.sync();
    vault.setFile("note.md", "v2, longer");
    await engine.sync();
    const shown = await engine.previewReclaim();
    vault.setFile("note.md", "v3, longer still"); // a sync while the dialog is open
    await engine.sync();
    const recomputed = await engine.previewReclaim();
    expect(recomputed.prunedManifests.length).toBeGreaterThan(shown.prunedManifests.length);

    const before = manifests(storage);
    const result = await engine.reclaimStorage(undefined, {
      sweep: shown.sweep,
      prunedManifests: shown.prunedManifests,
    });
    expect(result.prunedManifests).toBe(shown.prunedManifests.length);
    const gone = before.filter((k) => !manifests(storage).includes(k));
    expect(gone.sort()).toEqual([...shown.prunedManifests].sort());
  });

  it("without an approval it still sweeps what is ripe (the SDK default)", async () => {
    const { clock, engine } = await twoGarbageObjects();
    clock.advance(120);
    expect((await engine.reclaimStorage()).deleted).toHaveLength(2);
  });
});
