// Sixth post-fix review (ADR-0086). Before it: failed.
// Review 6 (ADR-0084/0085). R6-1: the winnerAt fork-lost test runs BEFORE the
// lineage test and overrides it. When the chain continued from the LOSER of a
// fork (the smaller-id device's PUT landed late, after G+1 was built on the
// other manifest), every device whose base is that loser — honestly ON the
// top's line — is told "fork-lost", plans without a base, and its local
// deletion is downloaded back (and its edits become conflicts). ADR-0084 now
// keeps the forked generation for ever, so pruning no longer ends it.
import { expect, it } from "vitest";
import { device, tick, write } from "../postfix-3/harness.js";
import { GatedStorage } from "../postfix-5/harness5.js";

it("a base on the top's line is trusted even when winnerAt names another device", async () => {
  const storage = new GatedStorage();
  const a = device(storage, "dev-a"); // smallest id: "wins" gen 2 by the fork rule
  const b = device(storage, "dev-b");
  const c = device(storage, "dev-c");

  write(b, "x.md", "x0");
  write(b, "y.md", "y0");
  await b.engine.sync(); // gen 1
  await a.engine.sync();
  await c.engine.sync();

  write(a, "a.md", "a's file");
  storage.beforeManifestPut("dev-a", async () => {
    // A's gen 2 PUT is slow. Meanwhile B publishes gen 2 (sees only itself),
    // C pulls it, and B builds gen 3 on it.
    write(b, "b.md", "b1");
    expect((await b.engine.sync()).outcome).toBe("applied"); // gen 2 (dev-b)
    expect((await c.engine.sync()).outcome).toBe("applied"); // c's base: gen 2 (dev-b)
    write(b, "b.md", "b2 longer");
    expect((await b.engine.sync()).outcome).toBe("applied"); // gen 3 on dev-b's gen 2
  });
  const ra = await a.engine.sync(); // A's gen 2 lands at a generation below the top
  expect(ra.outcome).toBe("pull-first");

  // C, on the line (gen 3 descends from its base), deletes x.md and edits y.md.
  tick();
  await c.vault.delete("x.md");
  write(c, "y.md", "y edited by c, longer");
  const rc = await c.engine.sync();
  expect(c.vault.getText("x.md"), "c's deletion was revived").toBeNull();
  expect(rc.conflicts, "spurious conflicts").toEqual([]);
  expect(c.log.lines.join(","), "c's honest base was rejected").not.toMatch(/fork-lost/);
});
