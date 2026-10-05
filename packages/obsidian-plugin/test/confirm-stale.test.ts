// ADR-0073: a Safe Sync confirmation that went stale under the dialog is said
// out loud and asked again with the plan as it is now. Audit №4 (B10): the
// engine applied nothing — correctly — and the plugin said nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import { engineOf, makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const STRICT = { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 };
const NAMES = ["a", "b", "c", "d", "e", "f"];

/** Another device deletes a, b, c; this one must confirm. */
async function confirming() {
  const world = new World();
  const other = await makeDevice(world, { ...S3_DATA, deviceId: "dev-other" });
  for (const n of NAMES) other.adapter.setFile(`${n}.md`, n);
  await unlock(other.plugin, PASS, true);
  await settle(other.plugin);
  const me = await makeDevice(world, { ...S3_DATA, safeSync: STRICT, autoSync: { enabled: false } });
  await unlock(me.plugin);
  await settle(me.plugin);
  for (const n of ["a", "b", "c"]) await other.adapter.remove(`${n}.md`);
  await engineOf(other).sync();
  return { me, other };
}

/** Each answer is "Apply"; `meanwhile(n)` runs while dialog n is open. */
function answers(me: { plugin: object }, meanwhile: (n: number) => Promise<void>) {
  let n = 0;
  return vi
    .spyOn(me.plugin as { ask(o: unknown): Promise<unknown> }, "ask")
    .mockImplementation(async () => {
      n++;
      await meanwhile(n);
      return true;
    });
}

describe("a confirmation that went stale (ADR-0073)", () => {
  it("is said, and asked again with the current list", async () => {
    const { me, other } = await confirming();
    const ask = answers(me, async (n) => {
      if (n === 1) {
        await other.adapter.remove("d.md"); // one more, while the list is open
        await engineOf(other).sync();
      }
    });
    await me.plugin.syncNow("manual");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(Notice.shown).toContain(EN_STRINGS.notices.confirmationChanged);
    for (const n of ["a", "b", "c", "d"]) expect(me.adapter.getText(`${n}.md`)).toBeNull();
    expect(me.adapter.getText("e.md")).toBe("e");
  });

  it("a plan that keeps moving is given up on, out loud, after two rounds", async () => {
    const { me, other } = await confirming();
    const ask = answers(me, async (n) => {
      await other.adapter.remove(`${["d", "e", "f"][n - 1] ?? "f"}.md`);
      await engineOf(other).sync();
    });
    await me.plugin.syncNow("manual");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(Notice.shown).toContain(EN_STRINGS.notices.confirmationGaveUp);
    expect(me.adapter.getText("a.md")).toBe("a"); // nothing applied
  });

  it("a plan that did not move is applied with one dialog", async () => {
    const { me } = await confirming();
    const ask = answers(me, () => Promise.resolve());
    await me.plugin.syncNow("manual");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(Notice.shown).not.toContain(EN_STRINGS.notices.confirmationChanged);
  });

  it("a lock that lands while applying says nothing about a stale list", async () => {
    const { me } = await confirming();
    answers(me, () => Promise.resolve());
    const engine = engineOf(me);
    vi.spyOn(engine, "confirmAndApply").mockImplementationOnce(async () => {
      const report = await engine.status();
      me.plugin.lock();
      return { ...(report.lastReport as object), outcome: "needs-confirmation" } as never;
    });
    await me.plugin.syncNow("manual");
    expect(Notice.shown).not.toContain(EN_STRINGS.notices.confirmationChanged);
  });
});
