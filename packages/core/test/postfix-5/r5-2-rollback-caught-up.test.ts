// Fifth post-fix review (ADR-0085). Before it: failed.
// R5-2: ADR-0038 refuses a rolled-back storage by comparing generation
// NUMBERS. Once the device that accepted the rollback has published past an
// offline device's base generation, the offline device is no longer
// "rolled back"; winnerAt(base.generation) names the same device that
// published the old manifest at that number, so the base — a manifest from
// the history the rollback erased — is trusted. Every file whose rolled-back
// version differs is then "remote is newer" and downloaded over local bytes
// that exist nowhere else any more.
import { expect, it } from "vitest";
import { device, everywhere, tick, write } from "../postfix-3/harness.js";
import { MemoryStorage } from "../../src/testing/index.js";

it("an offline device does not trust a base from a history erased by an accepted rollback", async () => {
  const storage = new MemoryStorage();
  // The phone does not carry note.md (profile); the laptop does.
  const a = device(storage, "dev-a", undefined, (p) => p !== "note.md");
  const e = device(storage, "dev-e");

  write(e, "note.md", "v0");
  await e.engine.sync(); // gen 1
  await a.engine.sync();
  write(e, "note.md", "E's edit (only copy), longer");
  await e.engine.sync(); // gen 2 (dev-e)
  write(a, "other.md", "a1");
  await a.engine.sync(); // gen 3 (dev-a)
  await e.engine.sync(); // e's base: gen 3, dev-a — then e goes offline

  // The storage loses generations 2 and 3 (a provider restore, a bucket
  // rollback): note.md is "v0" again in storage.
  for (const k of storage.keys()) {
    if (k.startsWith("manifests/000000002-") || k.startsWith("manifests/000000003-")) {
      await storage.delete(k);
    }
  }
  tick();
  expect((await a.engine.sync()).outcome).toBe("rolled-back");
  expect(await a.engine.acceptRolledBack()).toBe(true); // the user on the phone says OK
  for (let i = 0; i < 3; i++) {
    write(a, "other.md", `a${String(i + 2)} longer`);
    await a.engine.sync(); // gens 2, 3, 4 again, by dev-a
  }

  tick();
  const res = await e.engine.sync();
  const all = [...everywhere(a), ...everywhere(e)];
  expect(all, `e outcome ${res.outcome}; notices ${e.log.lines.join(",")}`).toContain(
    "E's edit (only copy), longer",
  );
});
