// Fifth post-fix review (ADR-0085). Before it: failed.
// R5-3 (ADR-0082): withoutForgotten drops a base entry older than the forget
// marker even when the storage's current entry at that path is the SAME
// content the base held. A device that deleted the file before it next
// synced then sees "absent here, live there, no base" and downloads it back:
// its deletion is undone silently instead of propagating, as it did before.
import { expect, it } from "vitest";
import { device, tick, write } from "../postfix-3/harness.js";
import { MemoryStorage } from "../../src/testing/index.js";

it("a local deletion survives a forget + re-add of the same content by another device", async () => {
  const storage = new MemoryStorage();
  const a = device(storage, "dev-a"); // desktop, carries att.png
  const b = device(storage, "dev-b"); // laptop, carries att.png
  const c = device(storage, "dev-c", undefined, (p) => p !== "att.png"); // phone, does not

  write(a, "att.png", "attachment bytes");
  write(a, "n.md", "n");
  await a.engine.sync();
  await b.engine.sync();
  await c.engine.sync();

  await a.vault.delete("att.png"); // the user deletes it on the desktop (not synced yet)

  // The phone forgets what it does not carry; the laptop re-adds its copy (ADR-0027).
  const u = await c.engine.listUncarried();
  expect((await c.engine.forgetPaths(u.map((x) => x.path))).forgotten).toEqual(["att.png"]);
  tick();
  await b.engine.sync();

  tick();
  const res = await a.engine.sync();
  expect(
    a.vault.getText("att.png"),
    `the desktop's deletion was undone: ${a.log.lines.join(",")} (${res.outcome})`,
  ).toBeNull();
});
