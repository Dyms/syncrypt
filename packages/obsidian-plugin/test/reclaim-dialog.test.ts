// ADR-0067 at the plugin: the reclaim dialog hands the engine what it SHOWED,
// as a ceiling. Closing a dialog that offered nothing to approve records the
// mark and deletes nothing; Reclaim deletes at most the listed objects and
// manifests. Both used to call the full operation (audit №4, B2).

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReclaimPlan } from "@syncrypt/core";

import { EN_STRINGS } from "../src/i18n.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import { engineOf, makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const plan = (over: Partial<ReclaimPlan>): ReclaimPlan => ({
  sweep: [],
  sweepBytes: 0,
  waiting: 0,
  waitingBytes: 0,
  ripeAt: null,
  prunedManifests: [],
  nextMark: { version: 1, unreachableSince: {} } as never,
  generation: 3,
  ...over,
});

async function openWith(preview: ReclaimPlan, answer: boolean) {
  const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  const engine = engineOf(me);
  vi.spyOn(engine, "previewReclaim").mockResolvedValue(preview);
  const run = vi.spyOn(engine, "reclaimStorage").mockResolvedValue({
    deleted: ["objects/aa"],
    bytesFreed: 10,
    prunedManifests: 0,
    waiting: 0,
    ripeAt: null,
  });
  vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockResolvedValue(
    answer,
  );
  await me.plugin.reclaimStorage();
  return run;
}

describe("the reclaim dialog passes what it showed (ADR-0067)", () => {
  it("closing 'nothing deletable yet' records the mark and approves nothing", async () => {
    const run = await openWith(plan({ waiting: 2, ripeAt: 1_900_000_000 }), false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual({ sweep: [], prunedManifests: [] });
  });

  it("closing a dialog that had something to approve does nothing at all", async () => {
    const run = await openWith(plan({ sweep: ["objects/aa"], waiting: 1, ripeAt: 1 }), false);
    expect(run).not.toHaveBeenCalled();
  });

  it("Reclaim approves exactly the listed objects and manifests", async () => {
    const shown = plan({ sweep: ["objects/aa"], prunedManifests: ["manifests/0001-x.json"] });
    const run = await openWith(shown, true);
    expect(run.mock.calls[0]?.[1]).toEqual({
      sweep: ["objects/aa"],
      prunedManifests: ["manifests/0001-x.json"],
    });
    // The notice reports what the engine did, not what the preview said.
    expect(Notice.shown).toContain(EN_STRINGS.reclaimModal.done(1, "10 B"));
  });
});
