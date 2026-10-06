// Fifth post-fix review (ADR-0085). Before it: failed.
// R5-1: a publish that wins its generation (re-list shows it as the smallest
// id at the top) is adopted as base and trusted for ever after — but another
// device can already be building G+1 on the LOSER of G. Its readRemote ran
// before the winner's PUT landed (only the loser was at G), and its own PUT
// lands after the winner's re-list. The chain then continues from the loser,
// winnerAt(G) still names the winner, so the winner's base is "vouched" and
// its edit — which no later manifest descends from — is downloaded over.
import { expect, it } from "vitest";
import { device, everywhere, tick, write } from "../postfix-3/harness.js";
import { gate, GatedStorage } from "./harness5.js";

it("the winner of G keeps its edit when the chain continued from the loser of G", async () => {
  const storage = new GatedStorage();
  const a = device(storage, "dev-a"); // smallest id: wins G
  const b = device(storage, "dev-b");

  write(a, "note.md", "v0");
  await a.engine.sync();
  await b.engine.sync();

  write(a, "note.md", "A's edit (only copy)"); // A's push of gen 2 is slow
  write(b, "b.md", "b1");

  const bSecond = gate();
  let bSecondPush: Promise<unknown> = Promise.resolve();
  storage.beforeManifestPut("dev-a", async () => {
    // While A's gen 2 PUT is in flight: B publishes gen 2 (sees only itself)…
    expect((await b.engine.sync()).outcome).toBe("applied");
    // …and starts another push, reading the top (its own gen 2) before A's
    // PUT lands; its gen 3 PUT is slow and lands after A's re-list.
    write(b, "b.md", "b2, longer");
    storage.beforeManifestPut("dev-b", bSecond.hook);
    bSecondPush = b.engine.push();
    await bSecond.reached;
  });
  const ra = await a.engine.sync(); // A's gen 2 lands; re-list: top 2, winner dev-a
  expect(ra.outcome).toBe("applied");
  bSecond.open();
  expect(((await bSecondPush) as { outcome: string }).outcome).toBe("applied"); // gen 3, built on B's gen 2

  tick();
  const res = await a.engine.sync();
  await b.engine.sync();
  const all = [...everywhere(a), ...everywhere(b)];
  expect(all, `A outcome ${res.outcome}; A notices ${a.log.lines.join(",")}`).toContain(
    "A's edit (only copy)",
  );
});
