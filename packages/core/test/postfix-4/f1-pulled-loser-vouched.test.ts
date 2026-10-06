// Fourth post-fix review (ADR-0084). Before it: failed.
// F1: "a pulled base is vouched" (ADR-0083) is unsound. A device that pulls
// its OWN freshly published generation G while a smaller-id device's G is
// still in flight sees only itself at G, adopts it with pull:true, and is
// vouched. The smaller-id device's G then lands and wins. Once reclamation
// prunes G, winnerAt(G) is null, the vouched base is trusted, and the
// loser's edit is overwritten by the winner's older version.
import { expect, it } from "vitest";
import { device, everywhere, InterleavingStorage, tick, write } from "../postfix-3/harness.js";

it("a lost fork the loser PULLED before the winner landed, then pruned, keeps the loser's edit", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a"); // wins every fork
  const b = device(storage, "dev-b");

  write(a, "note.md", "v0");
  await a.engine.sync();
  await b.engine.sync();

  write(b, "note.md", "B's edit (only copy)");
  write(a, "other.md", "a1");

  // A has read gen 1 and is uploading; meanwhile B syncs twice (its auto-sync
  // interval): publishes gen 2, then pulls it back as the only gen 2.
  storage.hold = async () => {
    expect((await b.engine.sync()).outcome).toBe("applied");
    await b.engine.sync();
  };
  await a.engine.sync(); // A's gen 2 lands and wins

  for (let i = 0; i < 10; i++) {
    write(a, "other.md", `a${i + 2}`);
    await a.engine.sync();
  }
  const r = await a.engine.reclaimStorage();
  expect(r.prunedManifests).toBeGreaterThan(0);

  tick();
  const res = await b.engine.sync();
  const all = [...everywhere(a), ...everywhere(b)];
  expect(all, `outcome ${res.outcome}; notices ${b.log.lines.join(",")}`).toContain(
    "B's edit (only copy)",
  );
});

it("a third device that pulled the loser's generation and the loser itself both lose the edit after pruning", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a");
  const b = device(storage, "dev-b");
  const c = device(storage, "dev-c");

  write(a, "note.md", "v0");
  await a.engine.sync();
  await b.engine.sync();
  await c.engine.sync();

  write(b, "note.md", "B's edit (only copy)");
  write(a, "other.md", "a1");
  storage.hold = async () => {
    await b.engine.sync(); // B publishes gen 2 (unvouched)
    await c.engine.sync(); // C pulls B's gen 2: vouched, holds B's edit
  };
  await a.engine.sync();

  for (let i = 0; i < 10; i++) {
    write(a, "other.md", `a${i + 2}`);
    await a.engine.sync();
  }
  await a.engine.reclaimStorage();
  tick();
  await c.engine.sync();
  await b.engine.sync();
  await c.engine.sync();
  await a.engine.sync();
  const all = [...everywhere(a), ...everywhere(b), ...everywhere(c)];
  expect(all).toContain("B's edit (only copy)");
});
