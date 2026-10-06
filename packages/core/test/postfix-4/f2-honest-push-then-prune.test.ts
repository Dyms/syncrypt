// Fourth post-fix review (ADR-0084). Before it: failed.
// F2: an ordinary sync ENDS with a push, so a device whose last sync uploaded
// anything holds an unvouched base until its next sync. If, meanwhile, other
// devices publish more than the retained generations and reclaim, ADR-0083
// plans that device's next sync from NO base, although its publish won and
// nothing forked: every file the other device edited becomes a conflict copy,
// and every file the other device DELETED is revived on all devices.
import { expect, it } from "vitest";
import { device, InterleavingStorage, tick, write } from "../postfix-3/harness.js";

it("a device whose last sync pushed (no fork) syncs cleanly after a reclaim pruned its generation", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a"); // the phone
  const b = device(storage, "dev-b"); // the laptop

  for (let i = 0; i < 5; i++) write(a, `n${String(i)}.md`, `v0-${String(i)}`);
  await a.engine.sync();
  await b.engine.sync();

  // The laptop's last act before the lid closes: an edit, synced (pushed).
  write(b, "laptop.md", "laptop note");
  expect((await b.engine.sync()).outcome).toBe("applied");

  // The phone, for days: edits, deletes, and a "Reclaim storage".
  await a.engine.sync();
  write(a, "n0.md", "phone edit of n0, longer");
  write(a, "n1.md", "phone edit of n1, longer");
  await a.vault.delete("n2.md");
  await a.engine.sync();
  for (let i = 0; i < 11; i++) {
    write(a, "other.md", `a${String(i)}`);
    await a.engine.sync();
  }
  const r = await a.engine.reclaimStorage();
  expect(r.prunedManifests).toBeGreaterThan(0);

  tick();
  const res = await b.engine.sync();
  await a.engine.sync();
  expect(res.conflicts, `notices ${b.log.lines.join(",")}`).toEqual([]);
  expect(b.vault.getText("n0.md")).toBe("phone edit of n0, longer");
  expect(a.vault.getText("n2.md"), "the phone's deletion was revived").toBeNull();
});

it("the plugin's push-on-quit / push-on-background is the last act: same pass", async () => {
  const storage = new InterleavingStorage();
  const a = device(storage, "dev-a");
  const b = device(storage, "dev-b");
  for (let i = 0; i < 3; i++) write(a, `n${String(i)}.md`, `v0-${String(i)}`);
  await a.engine.sync();
  await b.engine.sync();
  write(b, "laptop.md", "edited just before quitting");
  expect((await b.engine.push()).outcome).toBe("applied"); // syncNow("background")
  write(a, "n0.md", "phone edit of n0, longer");
  await a.engine.sync();
  for (let i = 0; i < 11; i++) {
    write(a, "other.md", `a${String(i)}`);
    await a.engine.sync();
  }
  await a.engine.reclaimStorage();
  tick();
  const res = await b.engine.sync();
  expect(res.conflicts, `notices ${b.log.lines.join(",")}`).toEqual([]);
});
