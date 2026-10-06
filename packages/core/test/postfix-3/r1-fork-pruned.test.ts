// R1: the loser of an unseen fork keeps its own manifest as base. ADR-0040
// detects it via winnerAt(base.generation) — which is null once reclamation
// has pruned that generation, and null "keeps the base". The loser's edit,
// which only its own vault holds, is then overwritten by the winner's older
// version with no conflict copy.
import { expect, it } from "vitest";
import { device, everywhere, InterleavingStorage, tick, write } from "./harness.js";

it("an unseen lost fork, pruned by reclamation, does not silently overwrite the loser's edit", async () => {
  const storage = new InterleavingStorage();
  // Default Safe Sync settings: 10 generations kept, 24h object grace
  // (manifests below the cut are pruned at once, ADR-0030).
  const a = device(storage, "dev-a"); // wins every fork (smallest id)
  const b = device(storage, "dev-b");

  write(a, "note.md", "v0");
  await a.engine.sync();
  await b.engine.sync();

  write(b, "note.md", "B's edit (only copy)");
  write(a, "other.md", "a1");

  // B publishes generation 2 first and sees only itself; A's gen 2 lands
  // after and wins. B has no way to know at publish time.
  storage.hold = async () => {
    expect((await b.engine.sync()).outcome).toBe("applied");
  };
  await a.engine.sync();

  // A moves on (ten more generations) and reclaims: gen 2 is pruned.
  for (let i = 0; i < 10; i++) {
    write(a, "other.md", `a${i + 2}`);
    await a.engine.sync();
  }
  const r = await a.engine.reclaimStorage();
  expect(r.prunedManifests).toBeGreaterThan(0);

  tick();
  const res = await b.engine.sync();
  const all = [...everywhere(a), ...everywhere(b)];
  expect(all, `outcome ${res.outcome}; notices ${b.log.lines.join(",")}`).toContain("B's edit (only copy)");
});

it("control: the same fork without the reclaim keeps the loser's edit (ADR-0040)", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a");
  const b = device(storage, "dev-b");
  write(a, "note.md", "v0");
  await a.engine.sync();
  await b.engine.sync();
  write(b, "note.md", "B's edit (only copy)");
  write(a, "other.md", "a1");
  storage.hold = async () => {
    await b.engine.sync();
  };
  await a.engine.sync();
  for (let i = 0; i < 10; i++) {
    write(a, "other.md", `a${i + 2}`);
    await a.engine.sync();
  }
  tick();
  await b.engine.sync();
  expect([...everywhere(a), ...everywhere(b)]).toContain("B's edit (only copy)");
});

it("an honest device whose generation won and was pruned still downloads, no conflict (ADR-0083)", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a");
  const b = device(storage, "dev-b");
  write(b, "note.md", "b's note");
  await b.engine.sync(); // b publishes gen 1 itself (unconfirmed)
  await b.engine.pull(); // and pulls past it: a base storage presented
  await a.engine.sync();
  for (let i = 0; i < 11; i++) {
    write(a, "other.md", `a${String(i)}`);
    await a.engine.sync();
  }
  write(a, "note.md", "a's edit of b's note, longer");
  await a.engine.sync();
  await a.engine.reclaimStorage(); // b's generation is pruned
  tick();
  const res = await b.engine.sync();
  expect(res.conflicts).toEqual([]);
  expect(b.vault.getText("note.md")).toBe("a's edit of b's note, longer");
});

it("a base pulled after an unverifiable one is vouched again (ADR-0083)", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a");
  const b = device(storage, "dev-b");
  write(b, "note.md", "b's note");
  await b.engine.sync(); // b's own publish, never seen to win…
  await a.engine.sync();
  for (let i = 0; i < 11; i++) {
    write(a, "other.md", `a${String(i)}`);
    await a.engine.sync();
  }
  await a.engine.reclaimStorage(); // …and pruned before b looked
  tick();
  await b.engine.sync(); // unverifiable once; adopts what it pulled
  for (let i = 0; i < 11; i++) {
    write(a, "other.md", `a-again${String(i)}`);
    await a.engine.sync();
  }
  write(a, "note.md", "a's edit, much later and longer");
  await a.engine.sync();
  await a.engine.reclaimStorage();
  tick();
  const res = await b.engine.sync();
  expect(res.conflicts).toEqual([]);
  expect(b.vault.getText("note.md")).toBe("a's edit, much later and longer");
});
